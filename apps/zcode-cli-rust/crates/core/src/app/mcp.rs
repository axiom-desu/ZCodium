use super::{Engine, auxiliary::Auxiliary, engine::Call};
use crate::contract::{Event, EventSink, ModelFailure, ProcessCleanupFailure, RuntimeError};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

impl Engine {
    /// `workspace/mcp/trust`（3.18 F7）：审核工作区来源的 MCP 声明。
    ///
    /// 本运行时只加载配置与插件来源的 MCP 服务器，没有工作区声明（`.agents/mcp.json`、
    /// 项目级 `mcpServers`），因此没有任何可达摘要可供信任：typed 拒绝，不返回
    /// `accepted: true`，也不新建第二份信任存储。工作区信任若将来接入，应由既有 MCP
    /// 所有者按真实声明摘要实现。
    pub(super) fn workspace_mcp_trust(&self, p: &Value) -> Result<Value> {
        let object = p
            .as_object()
            .filter(|o| {
                o.keys().all(|k| {
                    matches!(
                        k.as_str(),
                        "workspace" | "serverName" | "declarationDigest" | "trusted"
                    )
                })
            })
            .ok_or_else(|| {
                RuntimeError::invalid_params("Unsupported workspace/mcp/trust fields")
            })?;
        let workspace = object
            .get("workspace")
            .and_then(Value::as_object)
            .filter(|w| {
                w.keys()
                    .all(|k| matches!(k.as_str(), "workspacePath" | "workspaceIdentity"))
            })
            .ok_or_else(|| RuntimeError::invalid_params("workspace: required"))?;
        let valid = workspace
            .get("workspacePath")
            .and_then(Value::as_str)
            .is_some_and(|path| !path.is_empty())
            && ["serverName", "declarationDigest"].iter().all(|key| {
                object
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            })
            && object.get("trusted").is_some_and(Value::is_boolean);
        if !valid {
            return Err(RuntimeError::invalid_params(
                "workspace/mcp/trust requires workspace.workspacePath, serverName, declarationDigest and trusted",
            ));
        }
        tracing::warn!(
            target: "zcode::runtime",
            event = "workspace.mcp.trust.unsupported",
            "Workspace-scoped MCP declarations are not supported by this runtime"
        );
        Ok(json!({
            "accepted": false,
            "reasonCode": "workspace_mcp_trust_unavailable",
        }))
    }

    pub(super) fn start_mcp_query(&mut self, request: &Call) -> Result<()> {
        self.validate_workspace(&request.params)?;
        ensure!(self.auxiliary.len() < 16, "Too many auxiliary requests");
        let id = format!("mcp-query:{}", self.clock.id());
        let cancel = CancellationToken::new();
        self.auxiliary.insert(
            id.clone(),
            Auxiliary {
                token: request.token,
                cancel: cancel.clone(),
                operation: None,
                plugin_operation: None,
                title: None,
            },
        );
        let sink = EventSink {
            session_id: id.clone(),
            run_id: id,
            tx: self.events.clone(),
            origin: crate::contract::RequestOrigin::detached(self.clock.id()),
            request_auth: None,
        };
        let tools = self.tools.clone();
        let params = request.params.clone();
        tokio::spawn(async move {
            let result = tools.mcp_list(&params, &cancel).await;
            if result
                .as_ref()
                .is_err_and(|e| e.is::<ProcessCleanupFailure>())
            {
                let _ = sink
                    .send(Event::ToolCleanupFailed(
                        "MCP process cleanup failed".into(),
                    ))
                    .await;
            } else {
                let result =
                    result.map_err(|_| ModelFailure::new("mcp_configuration_failed", false));
                let _ = sink.send(Event::AuxiliaryDone { result }).await;
            }
        });
        Ok(())
    }
}
