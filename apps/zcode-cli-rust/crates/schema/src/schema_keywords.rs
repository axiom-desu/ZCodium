//! 已识别的 JSON Schema 关键字清单，以及标量关键字的读取/类型映射。
//! 关键字集合之外的任何键仍在编译期 fail closed（见 `lib.rs::Node::compile`）。
use super::Ty;
use serde_json::Value;

pub(super) const SUPPORTED: &[&str] = &[
    "$schema",
    "$id",
    "title",
    "description",
    "$comment",
    "deprecated",
    "readOnly",
    "writeOnly",
    "examples",
    "type",
    "enum",
    "const",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "properties",
    "required",
    "additionalProperties",
    "propertyNames",
    "items",
    "minItems",
    "maxItems",
    "anyOf",
    "oneOf",
    "default",
    "x-zcode-trim",
];

pub(super) fn ty(name: &str) -> Result<Ty, String> {
    Ok(match name {
        "string" => Ty::String,
        "number" => Ty::Number,
        "integer" => Ty::Integer,
        "boolean" => Ty::Boolean,
        "object" => Ty::Object,
        "array" => Ty::Array,
        "null" => Ty::Null,
        other => return Err(format!("unsupported type {other}")),
    })
}

pub(super) fn size(schema: &Value, key: &str) -> Result<Option<usize>, String> {
    schema
        .get(key)
        .map(|v| {
            v.as_u64()
                .map(|n| n as usize)
                .ok_or_else(|| format!("{key} must be a non-negative integer"))
        })
        .transpose()
}

pub(super) fn number(schema: &Value, key: &str) -> Result<Option<f64>, String> {
    schema
        .get(key)
        .map(|v| v.as_f64().ok_or_else(|| format!("{key} must be a number")))
        .transpose()
}
