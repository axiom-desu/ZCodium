//! ToolSearch / DeferredToolCall 控制入口的模型可见定义与注册元数据。
//!
//! 名字刻意不叫 `tool_search`：`tools/src/tool_search.rs` 是 Glob/Grep 的文件搜索实现，
//! 与这里的元工具无关。schema/description 均由
//! `scripts/generate-zcode-cli-rust-tool-schemas.mjs` 从真实 TS 注册 entry 生成；
//! 模型侧要求显式传入 `max_results`，执行侧仍先补默认值 5。
use crate::domain::tool_search::{
    DEFERRED_TOOL_CALL_NAME, TOOL_SEARCH_NAME, deferred_description, native_description,
};
use serde_json::{Value, json};

fn schemas() -> Value {
    serde_json::from_str(include_str!("tool_schemas.json")).expect("validated tool schemas")
}

/// 模型可见的 ToolSearch 输入 schema（`required` 含 `max_results`）。
pub fn tool_search_parameters() -> Value {
    schemas()["ToolSearch"].clone()
}

/// 模型可见的 DeferredToolCall 输入 schema。
pub fn deferred_parameters() -> Value {
    schemas()["DeferredToolCall"].clone()
}

/// 两个控制入口在注册目录里的定义（Off 时由请求准备隐藏）。
pub fn definitions() -> Vec<Value> {
    vec![
        json!({"type":"function","function":{
            "name": TOOL_SEARCH_NAME,
            "description": native_description(),
            "parameters": tool_search_parameters()}}),
        json!({"type":"function","function":{
            "name": DEFERRED_TOOL_CALL_NAME,
            "description": deferred_description(),
            "parameters": deferred_parameters()}}),
    ]
}

/// 只读、可并发执行的工具（Node `concurrentSafe`；ToolSearch 也在此列）。
pub fn concurrent_safe(name: &str) -> bool {
    crate::domain::tool_search::builtin_concurrent_safe(name)
}

/// 内置工具注册元数据（deferred / alwaysLoad / searchHint）。
pub fn metadata(name: &str) -> crate::domain::tool_search::Metadata {
    crate::domain::tool_search::builtin_metadata(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_require_both_model_fields() {
        let parameters = tool_search_parameters();
        assert_eq!(parameters["required"], json!(["query", "max_results"]));
        assert_eq!(parameters["properties"]["max_results"]["default"], 5);
        // 执行侧接受省略 max_results：默认值由 runtime 补齐，不放宽模型 schema。
        assert_eq!(deferred_parameters()["required"], json!(["name", "input"]));
    }

    #[test]
    fn tool_search_is_concurrent_safe_and_control_entries_never_deferred() {
        // native/local 共用同一个 ToolSearch 控制入口：只读且并发安全。
        assert!(concurrent_safe(TOOL_SEARCH_NAME));
        assert!(!concurrent_safe(DEFERRED_TOOL_CALL_NAME));
        assert!(!metadata(TOOL_SEARCH_NAME).should_defer);
        assert!(!metadata(DEFERRED_TOOL_CALL_NAME).should_defer);
    }

    #[test]
    fn control_entries_are_never_deferred() {
        assert!(!metadata(TOOL_SEARCH_NAME).should_defer);
        assert!(!metadata(DEFERRED_TOOL_CALL_NAME).should_defer);
        assert!(metadata("WebFetch").should_defer);
        assert!(!metadata("Read").should_defer);
    }
}
