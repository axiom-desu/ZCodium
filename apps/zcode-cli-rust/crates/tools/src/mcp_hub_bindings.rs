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
/// TS `MCP_APPS_UI_RESOURCE_SCHEME`: only `ui://` resources are App surfaces.
const UI_RESOURCE_SCHEME: &str = "ui://";
const UI_RESOURCE_MAX_CHARS: usize = 2048;
const SURFACE_MAX_CHARS: usize = 128;
const STRUCTURED_CONTENT_MAX_BYTES: usize = 64 * 1024;
const WIDGET_META_MAX_BYTES: usize = 16 * 1024;
const CONTENT_MAX_BYTES: usize = 32 * 1024;

fn ui_resource(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|uri| uri.starts_with(UI_RESOURCE_SCHEME) && uri.len() <= UI_RESOURCE_MAX_CHARS)
        .map(str::to_owned)
}

/// TS `readMcpToolVisibility`: `_meta.ui.visibility`, defaulting to model + app.
pub(super) fn visibility(tool: &Value) -> Vec<String> {
    tool["_meta"]["ui"]["visibility"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| matches!(*item, "model" | "app"))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| vec!["model".into(), "app".into()])
}

/// TS `normalizeMcpToolUiMeta`: resourceUri, surface and the display hints only.
pub(super) fn ui_descriptor(tool: &Value) -> Option<Value> {
    let meta = &tool["_meta"];
    let ui = &meta["ui"];
    let resource_uri = ui_resource(ui["resourceUri"].as_str())
        .or_else(|| ui_resource(meta["ui/resourceUri"].as_str()))
        .or_else(|| ui_resource(meta["openai/outputTemplate"].as_str()))?;
    let mut descriptor = json!({"resourceUri": resource_uri});
    if let Some(surface) = ui["surface"]
        .as_str()
        .map(str::trim)
        .filter(|surface| !surface.is_empty() && surface.len() <= SURFACE_MAX_CHARS)
    {
        descriptor["surface"] = surface.into();
    }
    if let Some(mode) = meta["openai/ui"]["preferredModelDisplayMode"].as_str() {
        descriptor["preferredDisplayMode"] = mode.into();
    }
    if let Some(border) = ui["prefersBorder"].as_bool() {
        descriptor["prefersBorder"] = border.into();
    }
    if let Some(inline) = ui["showInline"].as_bool() {
        descriptor["showInline"] = inline.into();
    }
    Some(descriptor)
}

/// One JSON field of the V4 display, omitted whole when it exceeds its byte budget
/// (TS `boundJsonText`): the UI must not receive half a JSON document.
fn bounded(display: &mut Value, key: &str, value: Option<&Value>, budget: usize) -> usize {
    let Some(value) = value else { return 0 };
    let text = serde_json::to_string(value).unwrap_or_default();
    if text.len() <= budget {
        display[key] = text.into();
        0
    } else {
        text.len()
    }
}

/// TS `createMcpToolDisplayUi` for the V4 host: the panel resource plus the result
/// metadata the page needs (structured content, `_meta`, content blocks).
pub(super) fn display(server: &str, ui: &Value, result: &Value) -> Value {
    let plugin_id = server
        .strip_prefix("plugin:")
        .and_then(|rest| rest.split(':').next())
        .unwrap_or(server);
    let mut display =
        json!({"kind":"mcp_tool","pluginId":plugin_id,"resourceUri":ui["resourceUri"]});
    for key in ["surface", "preferredDisplayMode", "prefersBorder"] {
        if let Some(value) = ui.get(key) {
            display[key] = value.clone();
        }
    }
    if ui["showInline"] == true {
        display["showInline"] = true.into();
    }
    let mut dropped = 0;
    dropped += bounded(
        &mut display,
        "structuredContent",
        result.get("structuredContent"),
        STRUCTURED_CONTENT_MAX_BYTES,
    );
    dropped += bounded(
        &mut display,
        "widgetMeta",
        result.get("_meta"),
        WIDGET_META_MAX_BYTES,
    );
    dropped += bounded(
        &mut display,
        "content",
        result.get("content"),
        CONTENT_MAX_BYTES,
    );
    if dropped > 0 {
        display["truncated"] = true.into();
        display["truncatedBytes"] = dropped.into();
    }
    // TS H06：MCP isError 的调用在 v4 行上仍是 success，页面与面板靠这个字段区分。
    if result["isError"] == true {
        display["isError"] = true.into();
    }
    display
}

pub(super) fn bind(
    server: &Server,
    key: &str,
    connection: &Arc<Connection>,
    names: &mut BTreeSet<String>,
) -> Result<Vec<Binding>> {
    let mut bindings = vec![];
    for tool in &connection.tools {
        // 与 TS `providerVisible` 一致：app-only 工具（面板、文件导入、读取令牌）只供 UI
        // 回调，不能进入 Rust 的模型工具表；TUI 没有页面宿主，也不伪造这些入口。
        if !visibility(tool).iter().any(|item| item == "model") {
            continue;
        }
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
            ui: ui_descriptor(tool),
            definition,
            connection: connection.clone(),
        });
    }
    Ok(bindings)
}

#[cfg(test)]
#[path = "mcp_hub_bindings_tests.rs"]
mod tests;
