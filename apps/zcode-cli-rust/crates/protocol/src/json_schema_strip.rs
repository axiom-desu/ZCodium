//! zod parse 输出语义：已通过校验的值经 `strip` 后与 Node 端结果同源。
//!
//! 单独成文件是为了把 `json_schema.rs` 控制在边界脚本的行数上限内。

use super::{Additional, Node, Ty};
use serde_json::Value;

impl Node {
    /// zod parse output for a value that already validated: explicit object schemas drop
    /// unknown keys (zod "strip"), passthrough objects (`additionalProperties: {}`) and
    /// untyped schemas keep them, and unions project through the first matching variant.
    /// Like zod, declared keys come first in schema order (absent ones take their
    /// `default`), then the kept unknown keys in input order.
    pub fn strip(&self, value: &Value) -> Value {
        if let Some(variant) = self
            .one_of
            .iter()
            .chain(&self.any_of)
            .find(|n| n.validate(value, "").is_ok())
        {
            return variant.strip(value);
        }
        match value {
            Value::Object(map) => {
                let explicit_object = self.types.as_ref().is_some_and(|t| t.contains(&Ty::Object));
                let mut out = serde_json::Map::new();
                for (key, schema) in &self.properties {
                    match map.get(key) {
                        Some(item) => {
                            out.insert(key.clone(), schema.strip(item));
                        }
                        None => {
                            if let Some(default) = &schema.default {
                                out.insert(key.clone(), default.clone());
                            }
                        }
                    }
                }
                for (key, item) in map {
                    if self.properties.iter().any(|(name, _)| name == key) {
                        continue;
                    }
                    match &self.additional {
                        Additional::Schema(schema) => {
                            out.insert(key.clone(), schema.strip(item));
                        }
                        Additional::Allow if !explicit_object => {
                            out.insert(key.clone(), item.clone());
                        }
                        Additional::Allow | Additional::Deny => {}
                    }
                }
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| {
                        self.items
                            .as_ref()
                            .map_or_else(|| item.clone(), |s| s.strip(item))
                    })
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}
