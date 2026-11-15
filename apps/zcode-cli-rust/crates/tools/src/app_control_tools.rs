//! 3.18 App 会话控制十二工具的模型定义。
//!
//! schema 与文案来自 TS 契约 `appSessionControlToolContracts` 的生成投影
//! （`scripts/generate-zcode-cli-rust-tool-schemas.mjs` → `app_session_control_tools.json`），
//! Rust 不手写第二份 schema 或文案。这里只决定它们在注册目录中的位置；
//! 可见性（Host 能力、根会话、非子代理）由 `core` 的请求准备按本轮事实裁剪。
use serde_json::Value;

const ASSET: &str = include_str!("app_session_control_tools.json");

/// 目录中的定义，顺序与 TS 契约表一致（`domain::app_control::TOOL_NAMES`）。
pub(super) fn definitions() -> Vec<Value> {
    let tools: Value = serde_json::from_str(ASSET).expect("validated App session control schemas");
    crate::domain::app_control::TOOL_NAMES
        .iter()
        .map(|name| {
            let tool = &tools[name];
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": tool["description"],
                    "parameters": tool["parameters"],
                },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成资产、意图表与定义三者不得漂移。
    #[test]
    fn the_generated_asset_covers_every_intent_exactly_once() {
        let tools: Value = serde_json::from_str(ASSET).unwrap();
        let names: Vec<&str> = tools
            .as_object()
            .expect("asset is an object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(names, crate::domain::app_control::TOOL_NAMES);
        let definitions = definitions();
        assert_eq!(definitions.len(), 12);
        for (definition, name) in definitions
            .iter()
            .zip(crate::domain::app_control::TOOL_NAMES)
        {
            assert_eq!(definition["function"]["name"], name);
            assert_eq!(definition["function"]["parameters"]["type"], "object");
            assert!(
                definition["function"]["description"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty()),
                "{name}"
            );
            // 模型输入只提供 `input`：身份字段不能出现在工具 schema 里。
            for field in ["callerSessionId", "callId", "requestId"] {
                assert!(
                    definition["function"]["parameters"]["properties"][field].is_null(),
                    "{name} exposes {field}"
                );
            }
        }
    }
}
