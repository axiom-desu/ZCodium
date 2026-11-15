//! 上游 3.18.2 F4：`v4/conversation/contextComposition` 查询。
//!
//! 只用 owner（Engine 内存中的 Session）已经记录的真实请求分解；查询不加载会话、
//! 不重算、不触发模型请求。没有请求记录或会话不在内存时返回 `null`。
use super::Engine;
use crate::contract::RuntimeError;
use anyhow::Result;
use serde_json::{Value, json};

/// `modelSelection` 的结构校验：完整选择，选项只允许思考档位（与 TS schema 同义）。
fn valid_selection(selection: &Value) -> bool {
    let Some(object) = selection.as_object() else {
        return false;
    };
    let filled = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    object
        .keys()
        .all(|key| matches!(key.as_str(), "providerId" | "modelId" | "options"))
        && filled("providerId")
        && filled("modelId")
        && object.get("options").is_none_or(|options| {
            options.as_object().is_some_and(|options| {
                options.keys().all(|key| key == "reasoningLevel")
                    && options
                        .get("reasoningLevel")
                        .is_none_or(|level| level.as_str().is_some_and(|value| !value.is_empty()))
            })
        })
}

impl Engine {
    pub(super) fn context_composition_query(&self, p: &Value) -> Result<Value> {
        let object = p
            .as_object()
            .filter(|object| {
                object
                    .keys()
                    .all(|key| matches!(key.as_str(), "sessionId" | "modelSelection"))
            })
            .ok_or_else(|| {
                RuntimeError::invalid_params(
                    "Unsupported v4/conversation/contextComposition fields",
                )
            })?;
        let id = object
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| RuntimeError::invalid_params("sessionId: required"))?;
        if let Some(selection) = object.get("modelSelection")
            && !valid_selection(selection)
        {
            return Err(RuntimeError::invalid_params("modelSelection: invalid"));
        }
        // `modelSelection` 不改变结果：composition 描述的是会话真实发出的那次请求。
        let composition = self
            .sessions
            .get(id)
            .and_then(|session| session.context_composition.clone())
            .unwrap_or(Value::Null);
        Ok(json!({"composition": composition}))
    }
}

#[cfg(test)]
mod tests {
    use super::valid_selection;
    use serde_json::json;

    #[test]
    fn model_selection_must_be_a_complete_strict_identity() {
        assert!(valid_selection(&json!({
            "providerId": "zhipu", "modelId": "glm", "options": {"reasoningLevel": "high"}
        })));
        assert!(valid_selection(
            &json!({"providerId": "zhipu", "modelId": "glm"})
        ));
        assert!(!valid_selection(&json!({"providerId": "zhipu"})));
        assert!(!valid_selection(&json!({
            "providerId": "zhipu", "modelId": "glm", "options": {"temperature": 1}
        })));
        assert!(!valid_selection(&json!({
            "providerId": "zhipu", "modelId": "glm", "extra": true
        })));
        assert!(!valid_selection(
            &json!({"providerId": " ", "modelId": "glm"})
        ));
    }
}
