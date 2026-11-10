use super::{
    Engine,
    protocol::{PROTOCOL_NAME, PROTOCOL_VERSION},
};
use crate::contract::{Method, RuntimeError};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

impl Engine {
    fn execution_capabilities(&self) -> Value {
        json!({"permissionModes":["build","edit","yolo","auto"],"independentPlanState":true})
    }

    pub(super) fn workspace_config(&self) -> Value {
        let options = self.catalog();
        json!({"executionCapabilities":self.execution_capabilities(),"configOptions":if options.is_empty(){vec![]}else{vec![json!({"id":"model","name":"Model","type":"select","currentValue":self.config.as_ref().map(|c|c.model_id.as_str()).unwrap_or(""),"options":options})]},"slashCommands":[{"name":"compact","description":"Compact conversation context","source":"builtin"}]})
    }

    pub(super) fn validate_workspace(&self, p: &Value) -> Result<()> {
        if let Some(workspace) = p.get("workspace") {
            let key = workspace["workspaceIdentity"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| workspace["workspacePath"].as_str())
                .context("Workspace required")?;
            if key != self.workspace {
                bail!("Workspace identity mismatch");
            }
        }
        Ok(())
    }
    pub(super) fn query(&mut self, method: Method, p: &Value) -> Result<Value> {
        self.validate_workspace(p)?;
        match method {
            Method::WorkspaceCancelGenerateText => {
                let operation = p["operationId"].as_str().context("Operation id required")?;
                let ids = self
                    .auxiliary
                    .iter()
                    .filter(|(_, j)| j.operation.as_deref() == Some(operation))
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in &ids {
                    self.auxiliary[id].cancel.cancel();
                    self.cancel_auth(id);
                }
                Ok(json!({"operationId":operation,"cancelled":!ids.is_empty()}))
            }
            Method::PluginsCancelOperation => {
                // Node 按原样的 operationId 查找（登记时已去空白），只中止当前登记的作业。
                let operation = p["operationId"].as_str().context("Operation id required")?;
                let job = self
                    .auxiliary
                    .values_mut()
                    .find(|j| j.plugin_operation.as_deref() == Some(operation));
                let cancelled = job.is_some_and(|job| {
                    job.cancel.cancel();
                    job.plugin_operation = None;
                    true
                });
                Ok(json!({"operationId":operation,"cancelled":cancelled}))
            }
            // 握手身份是静态事实：不读 workspace/model/网络，响应只含能力与协议身份。
            Method::RuntimeCapabilities => Ok(
                json!({"protocol":{"name":PROTOCOL_NAME,"version":PROTOCOL_VERSION},"workspaceExecutionCapabilities":true,"independentPlanState":true,"accountProviderConfig":self.registry.is_some()}),
            ),
            Method::ProcessChildProcesses => Ok(json!({"processes": self.tools.child_processes()})),
            Method::WorkspaceReadPresentation => {
                // 旧 App 使用 strict schema；未协商的客户端不能收到新增字段。
                let mut presentation = json!({"workspace":p["workspace"],"mode":"yolo","slashCommands":[{"name":"compact","description":"Compact conversation context","source":"builtin"}]});
                if p["includeExecutionCapabilities"] == true {
                    presentation["executionCapabilities"] = self.execution_capabilities();
                }
                Ok(presentation)
            }
            Method::ConversationRowsRange | Method::ConversationPlans => {
                let session = self
                    .sessions
                    .get(p["sessionId"].as_str().context("Session id required")?)
                    .context("Session unavailable")?;
                if method == Method::ConversationPlans {
                    let plans = session
                        .rows
                        .iter()
                        .rev()
                        .filter(|r| {
                            r["kind"] == "toolCall"
                                && r["toolName"] == "ExitPlanMode"
                                && matches!(
                                    r["status"].as_str(),
                                    Some("success" | "error" | "cancelled")
                                )
                                && serde_json::from_str::<Value>(
                                    r["inputText"].as_str().unwrap_or(""),
                                )
                                .ok()
                                .is_some_and(|v| {
                                    v["plan"].as_str().is_some_and(|p| !p.trim().is_empty())
                                })
                        })
                        .collect::<Vec<_>>();
                    return Ok(
                        json!({"plans":plans,"atSeq":session.seq,"atLogEpoch":session.epoch}),
                    );
                }
                let limit = p["limit"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 200)
                    .ok_or_else(|| RuntimeError::invalid_params("limit: expected 1..=200"))?
                    as usize;
                let before = p["beforeRowId"].as_u64().unwrap_or(u64::MAX);
                let (rows, has_more) =
                    crate::domain::row_page::page(&session.rows, before, limit, 900 * 1024)?;
                Ok(
                    json!({"rows":rows,"atSeq":session.seq,"atRevision":session.revision,"atLogEpoch":session.epoch,"hasMore":has_more}),
                )
            }
            // 路由保证只把查询类方法交到这里；其余方法到达此处说明分派表缺项。
            method => Err(RuntimeError::MethodNotFound(method.as_str().into()).into()),
        }
    }
}

/// `runtime/capabilities` 的握手身份必须是静态事实：不读 workspace、模型或网络，
/// 响应里只有能力与协议身份。测试用最小端口，不写任何存储；workspace 用临时目录路径，
/// 既贴近真实调用，也验证路径不会被回显。
#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{ContextPort, RuntimeClock, RuntimePorts, SessionStore, ToolPort};
    use async_trait::async_trait;
    use std::{collections::BTreeMap, sync::Arc};
    use tokio_util::sync::CancellationToken;

    #[derive(Default)]
    struct NoStore;

    #[async_trait]
    impl SessionStore for NoStore {
        async fn load_index(&self, _: &str) -> Result<BTreeMap<String, Value>> {
            Ok(BTreeMap::new())
        }
        async fn lookup_ack(&self, _: &str, _: &str) -> Result<Option<Value>> {
            Ok(None)
        }
        async fn load(
            &self,
            _: &str,
        ) -> Result<(
            Vec<crate::domain::session::Session>,
            BTreeMap<String, Value>,
        )> {
            Ok((vec![], BTreeMap::new()))
        }
        async fn commit(
            &self,
            _: &str,
            _: Option<&mut crate::domain::session::Session>,
            _: Option<(String, Value)>,
        ) -> Result<()> {
            Ok(())
        }
    }

    struct NoTools;

    #[async_trait]
    impl ToolPort for NoTools {
        fn definitions(&self) -> Vec<Value> {
            vec![]
        }
        async fn execute(&self, _: &str, _: &Value, _: &CancellationToken) -> Result<String> {
            bail!("tool execution must be unused")
        }
        async fn cancel_session(&self, _: &str, _: Option<&str>) -> Result<()> {
            Ok(())
        }
    }

    struct FixedClock;

    impl RuntimeClock for FixedClock {
        fn now(&self) -> u64 {
            123
        }
        fn id(&self) -> String {
            "fixed-epoch".into()
        }
    }

    struct UnusedContext;

    #[async_trait]
    impl ContextPort for UnusedContext {
        fn desktop(&self) -> bool {
            false
        }
        async fn snapshot(
            &self,
            _: &CancellationToken,
        ) -> Result<crate::domain::prompt::PromptSnapshot> {
            bail!("ContextPort must be unused")
        }
        async fn instructions(
            &self,
            _: &CancellationToken,
        ) -> Result<Vec<crate::domain::prompt::InstructionSource>> {
            bail!("ContextPort must be unused")
        }
    }

    #[tokio::test]
    async fn runtime_capabilities_announce_the_legacy_protocol_identity() {
        let workspace = std::env::temp_dir()
            .join(format!("zcode-runtime-caps-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let mut engine = Engine::new(
            workspace.clone(),
            None,
            RuntimePorts {
                context: Arc::new(UnusedContext),
                store: Arc::new(NoStore),
                model: None,
                tools: Arc::new(NoTools),
                clock: Arc::new(FixedClock),
            },
        )
        .await
        .unwrap();

        let capabilities = engine
            .query(Method::RuntimeCapabilities, &json!({}))
            .unwrap();

        // 与 legacy session 快照同名的协议身份；V4 physical wire 版本不在此响应里。
        assert_eq!(
            capabilities,
            json!({
                "protocol": {"name": "ZCode Protocol", "version": 1},
                "workspaceExecutionCapabilities": true,
                "independentPlanState": true,
                "accountProviderConfig": false,
            })
        );
        // 不泄露 workspace 路径，也不附加模型/账号/会话事实。
        let text = capabilities.to_string();
        assert!(!text.contains(&workspace), "{text}");
        for key in [
            "model",
            "provider",
            "session",
            "workspace",
            "user",
            "account",
        ] {
            assert!(
                !capabilities.as_object().unwrap().contains_key(key),
                "unexpected {key} in {text}"
            );
        }
    }
}
