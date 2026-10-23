//! A session's bound MCP tools: binding a server's tools and queries over them.
use super::super::mcp_config::{self, Server};
use super::super::mcp_connection::Connection;
use super::{Binding, Hub};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

impl Hub {
    /// ToolSearch 元数据：MCP 工具使用真实 `_meta` 与 server 配置。
    pub fn tool_search_metadata(
        &self,
        session: &str,
        name: &str,
    ) -> crate::domain::tool_search::Metadata {
        let Some(binding) = self
            .state
            .read()
            .unwrap()
            .bindings
            .get(session)
            .and_then(|bindings| bindings.iter().find(|b| b.name == name))
            .cloned()
        else {
            return Default::default();
        };
        crate::domain::tool_search::Metadata {
            should_defer: true,
            always_load: binding.always_load,
            search_hint: binding.search_hint.clone(),
            provider_native: false,
            mcp: Some(crate::domain::tool_search::McpName {
                server_name: binding.server.clone(),
                tool_name: binding.original.clone(),
            }),
        }
    }
    fn binding<T>(&self, session: &str, name: &str, f: impl FnOnce(&Binding) -> T) -> Option<T> {
        let state = self.state.read().unwrap();
        let bindings = state.bindings.get(session)?;
        bindings.iter().find(|b| b.name == name).map(f)
    }
    /// The annotations Node records for a bound MCP tool.
    pub fn hints(&self, session: &str, name: &str) -> Option<Value> {
        self.binding(
            session,
            name,
            |b| json!({"readOnlyHint": b.read_only, "destructiveHint": b.destructive}),
        )
    }
    pub fn safe(&self, session: &str, name: &str) -> bool {
        self.binding(session, name, |b| b.safe).unwrap_or(false)
    }
}
pub(super) fn bind(
    server: &Server,
    key: &str,
    connection: &Arc<Connection>,
    names: &mut BTreeSet<String>,
) -> Result<Vec<Binding>> {
    let mut bindings = vec![];
    for tool in &connection.tools {
        let original = tool["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("MCP tool name required")?;
        let name = mcp_config::tool_name(&server.name, original);
        ensure!(names.insert(name.clone()), "MCP tool namespace collision");
        ensure!(tool["inputSchema"].is_object(), "MCP tool schema required");
        let definition = json!({"type":"function","function":{"name":name,"description":tool["description"].as_str().unwrap_or(""),"parameters":tool["inputSchema"]}});
        // 只读真实 `_meta`：非布尔/非字符串按未配置处理，不改变连接、鉴权或权限。
        let always_load = matches!(tool["_meta"]["anthropic/alwaysLoad"].as_bool(), Some(true))
            || server.always_load == Some(true);
        let search_hint = tool["_meta"]["anthropic/searchHint"]
            .as_str()
            .filter(|hint| !hint.trim().is_empty())
            .map(str::to_owned);
        ensure!(
            definition.to_string().len() <= 256 * 1024,
            "MCP schema exceeds size limit"
        );
        bindings.push(Binding {
            name,
            server: server.name.clone(),
            original: original.into(),
            key: key.into(),
            safe: tool["annotations"]["readOnlyHint"] == true
                && tool["annotations"]["destructiveHint"] == false,
            read_only: tool["annotations"]["readOnlyHint"] == true,
            destructive: tool["annotations"]["destructiveHint"] == true,
            always_load,
            search_hint,
            definition,
            connection: connection.clone(),
        });
    }
    Ok(bindings)
}
