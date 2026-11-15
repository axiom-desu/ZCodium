//! Engine actor 的单次请求处理（`Engine::request`）。
//! 拆分自 `engine.rs`，方法体逐字搬移，只为把源文件保持在 400 行上限内。
use super::{Call, Engine, RuntimeOutput};
use crate::contract::{Method, RuntimeError, ServerMsg, StorageCommitFailure};
use anyhow::Result;

impl Engine {
    pub(super) async fn request(&mut self, call: Call, output: &RuntimeOutput) -> Result<()> {
        self.outbox.clear();
        let token = call.token;
        // 这些请求在后台完成，稍后以同一 token 回复；这里只回复启动失败。
        let deferred = match call.method {
            Method::McpList => Some(self.start_mcp_query(&call)),
            method if method.is_plugin() => Some(self.start_plugin_request(&call).await),
            Method::UsageStats
            | Method::LegacyUsageStats
            | Method::ConversationUsage
            | Method::SessionUsage => return self.usage_query(&call, output).await,
            Method::WorkspaceGenerateText | Method::ProviderTestModelConnectivity => {
                Some(self.start_auxiliary(&call))
            }
            _ => None,
        };
        if let Some(started) = deferred {
            if let Err(error) = started {
                // 保持既有 -32602 响应，启动失败均为请求校验问题。
                let error = RuntimeError::Coded {
                    code: -32602,
                    message: error.to_string(),
                };
                output
                    .send(vec![ServerMsg::Reply {
                        token,
                        result: Err(error),
                    }])
                    .await?;
            }
            return Ok(());
        }
        let p = &call.params;
        let result = match call.method {
            // 与 Node CommandInbox 一致：信封或 payload 不合法时回 rejected ACK，而非 RPC 错误。
            Method::Command => match zcode_cli_protocol::parse_command(p) {
                Err(issue) => Ok(zcode_cli_protocol::invalid_payload_ack(p, &issue)),
                Ok(command) => self.ttft_command(command, p).await,
            },
            Method::TopicOpen => self.open_topic(p).await,
            Method::TopicSnapshot => self.topic_snapshot_value(p),
            Method::AttachmentBegin
            | Method::AttachmentChunk
            | Method::AttachmentCommit
            | Method::AttachmentAbort => self.attachment_upload(call.method.as_str(), p).await,
            Method::AttachmentRead
            | Method::AttachmentPreviewSource
            | Method::ConversationAttachmentRead
            | Method::ConversationAttachmentStat
            | Method::ConversationRowsRange
            | Method::ConversationPlans => self.conversation_query(call.method, p).await,
            Method::WorkspaceUpdateInteractionPreferences => self.interaction_preferences(p).await,
            Method::WorkspaceHooksTrustGrant => self.trust_grant(p).await,
            Method::ConversationFileChanges => self.file_changes(p).await,
            Method::ConversationFileRewindPreview => self.rewind_preview(p).await,
            Method::SessionRead => self.read_cold_session(p).await,
            Method::WorkspaceMcpTrust => self.workspace_mcp_trust(p),
            Method::ConversationContextComposition => self.context_composition_query(p),
            Method::InputHistoryRecall => self.input_history_recall(p).await,
            Method::CommandsQuery => self.query_acks(p).await,
            Method::SessionList => self.list_sessions(p).await,
            Method::SessionsIndexReconcile => self.reconcile_sessions(p).await,
            Method::SessionSubagents => self.subagents_query(p).await,
            Method::SessionClose => self.close_runtime_session(p).await,
            Method::SessionDataMeasure
            | Method::SessionDataPurge
            | Method::SessionDataDeletionPreview
            | Method::SessionDataDeletionExecute => self.session_data(call.method, p).await,
            Method::SessionLifecycleGetState
            | Method::SessionLifecycleEnsureReady
            | Method::SessionLifecycleStop
            | Method::SessionLifecycleRestart => self.session_lifecycle(call.method, p).await,
            Method::SkillsReferenceCatalog => self.skill_catalog(p).await,
            Method::SessionCreate => self.legacy_create(p).await,
            Method::SessionResume => self.legacy_resume(p).await,
            Method::SessionSubscribe => self.legacy_subscribe(p),
            Method::SessionDebug => self.session_debug(p),
            Method::SessionSetModel | Method::SessionSetThoughtLevel | Method::SessionSetMode => {
                self.legacy_setter(call.method, p).await
            }
            Method::SessionSend => self.legacy_send(p).await,
            Method::SessionCompact => self.legacy_compact(p).await,
            Method::SessionGoal => self.legacy_goal(p).await,
            Method::ProviderUpdateAccountConfig => self.update_account(p).await,
            method => self.query(method, p),
        };
        let storage_failed = result
            .as_ref()
            .err()
            .is_some_and(|e| e.is::<StorageCommitFailure>());
        let result = result.map_err(|error| {
            // 失败请求不能发布半途产生的事件。
            self.outbox.clear();
            let error = RuntimeError::classify(&error);
            // 只记录方法与错误码：错误文本可能包含用户路径或内容，不写入日志。
            tracing::warn!(
                target: "zcode::runtime",
                event = "rpc.request.failed",
                method = call.method.as_str(),
                code = error.code(),
                "Request failed"
            );
            error
        });
        let mut batch = vec![ServerMsg::Reply { token, result }];
        batch.append(&mut self.outbox);
        output.send(batch).await?;
        if storage_failed {
            tracing::error!(
                target: "zcode::runtime",
                event = "storage.commit.failed",
                method = call.method.as_str(),
                "Storage commit failed; stopping runtime"
            );
            return Err(StorageCommitFailure.into());
        }
        self.trim_resident().await?;
        Ok(())
    }
}
