//! Node `adapters/model/tool-search.ts` 的模型侧：真实能力判定、beta 合并与
//! Anthropic wire 编码（`defer_loading` 与 `tool_reference` → `tool_name`）。
//!
//! 请求准备（哪些工具 native 曝光、公告与发现集）属于 Core/ToolSearch 切片；
//! 本模块只把已决定的 `ModelRequestOptions` 编码成真实 HTTP。
use super::{config::ModelConfig, model_protocol::ApiType};
use crate::contract::{ModelFailure, ToolSearchCapability};
use serde_json::{Value, json};
use zcode_cli_net::Headers;

/// Node `TOOL_SEARCH_BETA`（Anthropic advanced tool use）。
pub(super) const BETA: &str = "advanced-tool-use-2025-11-20";
/// AI SDK `webSearch_20260209` 的 beta：既有的原生搜索 beta，必须原样保留。
pub(super) const WEB_SEARCH_BETA: &str = "code-execution-web-tools-2026-02-09";

/// Node `resolveToolSearchCapability`：只读真实非秘密的协议与访问方式。
/// 不恢复已移除的 requestAuth/highspeed/offpeak 分支。
pub(super) fn capability(config: &ModelConfig) -> ToolSearchCapability {
    ToolSearchCapability::for_access(
        config.api_type == ApiType::Anthropic,
        config.access_type.as_deref().unwrap_or(""),
        config.access_mode.as_deref(),
    )
}

/// Node 请求前的 `native` 能力校验：非 Anthropic 协议不能发送原生引用。
pub(super) fn ensure_native(config: &ModelConfig) -> Result<(), ModelFailure> {
    if config.api_type == ApiType::Anthropic {
        Ok(())
    } else {
        Err(ModelFailure::new("tool_search_unsupported", false))
    }
}

/// 大小写无关读取 `anthropic-beta`，按逗号去重追加，保留其它既有 beta。
/// 不覆盖显式配置的其它 beta，也不因为大小写不同的同名 Header 丢值。
pub(super) fn append_beta(headers: &mut Headers, beta: &str) {
    let existing = headers.get("anthropic-beta").unwrap_or("");
    let mut values = existing
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !values.iter().any(|value| value == beta) {
        values.push(beta.to_owned());
    }
    headers.set("anthropic-beta", values.join(","));
}

/// Anthropic `tools` 编码：只有请求契约里 `deferLoading` 的工具在 native 模式下
/// 带 `defer_loading`，定义本身保持完整（Node 只给已发现 deferred schema 标延迟）。
pub(super) fn anthropic_tools(tools: &[Value], native: bool) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| match tool["type"].as_str() {
            Some("function") => {
                let mut encoded = json!({
                    "name": tool["function"]["name"],
                    "description": tool["function"]["description"],
                    "input_schema": tool["function"]["parameters"],
                });
                if native && tool["deferLoading"] == true {
                    encoded["defer_loading"] = true.into();
                }
                encoded
            }
            // provider 原生工具（web_search_20260209）原样发送。
            _ => tool.clone(),
        })
        .collect()
}

/// 工具结果里的引用块：内部字段 `toolName`，HTTP 字段 `tool_name`。
/// 定义未变时服务端据此展开真实 schema，不能换成工具名字符串或 XML。
pub(super) fn tool_reference(block: &Value) -> Option<Value> {
    let name = block["toolName"].as_str().filter(|name| !name.is_empty())?;
    Some(json!({"type":"tool_reference","tool_name":name}))
}

#[cfg(test)]
#[path = "tool_search_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "tool_search_wire_tests.rs"]
mod wire_tests;
