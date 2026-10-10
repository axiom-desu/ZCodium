//! Minimal JSON Schema validator for the keyword subset emitted by zod's
//! `toJSONSchema` for the V4 command contract.
//!
//! Compilation rejects any keyword outside the supported subset, so a new zod
//! construct surfaces as a failing test instead of being silently ignored.
//! String lengths use UTF-16 code units to match zod (JavaScript `length`).
//!
//! `pattern` 使用 Rust `regex` 而非 ECMAScript 引擎：当前由 zod 产出的 pattern 全部是
//! 纯 ASCII 字符类（hex digest、uuid 交替），两种引擎语义一致。若未来引入 lookaround
//! 等 JS 专有构造，Rust 侧会在编译 schema 时直接失败并使测试报错（fail-closed），
//! 不会静默误判。
#[path = "json_schema_strip.rs"]
mod json_schema_strip;
use regex::Regex;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq)]
enum Ty {
    String,
    Number,
    Integer,
    Boolean,
    Object,
    Array,
    Null,
}

enum Additional {
    Allow,
    Deny,
    Schema(Box<Node>),
}

pub struct Node {
    types: Option<Vec<Ty>>,
    enumeration: Option<Vec<Value>>,
    constant: Option<Value>,
    min_length: Option<usize>,
    max_length: Option<usize>,
    pattern: Option<Regex>,
    /// `format: "uuid"`。zod 的 `.uuid()` 会产出该 format；不校验就是静默放行。
    uuid_format: bool,
    minimum: Option<f64>,
    maximum: Option<f64>,
    exclusive_minimum: Option<f64>,
    properties: Vec<(String, Node)>,
    required: Vec<String>,
    additional: Additional,
    property_names: Option<Box<Node>>,
    items: Option<Box<Node>>,
    min_items: Option<usize>,
    max_items: Option<usize>,
    any_of: Vec<Node>,
    one_of: Vec<Node>,
    default: Option<Value>,
}

const SUPPORTED: &[&str] = &[
    "$schema",
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
];

fn ty(name: &str) -> Result<Ty, String> {
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

fn size(schema: &Value, key: &str) -> Result<Option<usize>, String> {
    schema
        .get(key)
        .map(|v| {
            v.as_u64()
                .map(|n| n as usize)
                .ok_or_else(|| format!("{key} must be a non-negative integer"))
        })
        .transpose()
}

fn number(schema: &Value, key: &str) -> Result<Option<f64>, String> {
    schema
        .get(key)
        .map(|v| v.as_f64().ok_or_else(|| format!("{key} must be a number")))
        .transpose()
}

impl Node {
    pub fn compile(schema: &Value) -> Result<Self, String> {
        let object = schema.as_object().ok_or("schema must be an object")?;
        if let Some(key) = object.keys().find(|k| !SUPPORTED.contains(&k.as_str())) {
            return Err(format!("unsupported schema keyword {key}"));
        }
        if let Some(format) = schema.get("format").and_then(Value::as_str)
            && format != "uuid"
        {
            return Err(format!("unsupported format {format}"));
        }
        let types = match schema.get("type") {
            None => None,
            Some(Value::String(name)) => Some(vec![ty(name)?]),
            Some(Value::Array(names)) => Some(
                names
                    .iter()
                    .map(|n| {
                        n.as_str()
                            .ok_or("type entries must be strings")
                            .map_err(String::from)
                            .and_then(ty)
                    })
                    .collect::<Result<_, _>>()?,
            ),
            Some(_) => return Err("type must be a string or array".into()),
        };
        let child = |key: &str| {
            schema
                .get(key)
                .map(|v| Node::compile(v).map(Box::new))
                .transpose()
        };
        Ok(Self {
            types,
            enumeration: schema.get("enum").and_then(Value::as_array).cloned(),
            constant: schema.get("const").cloned(),
            min_length: size(schema, "minLength")?,
            max_length: size(schema, "maxLength")?,
            uuid_format: schema.get("format").and_then(Value::as_str) == Some("uuid"),
            pattern: schema
                .get("pattern")
                .and_then(Value::as_str)
                .map(|p| Regex::new(p).map_err(|e| format!("pattern {p}: {e}")))
                .transpose()?,
            minimum: number(schema, "minimum")?,
            maximum: number(schema, "maximum")?,
            exclusive_minimum: number(schema, "exclusiveMinimum")?,
            properties: schema
                .get("properties")
                .and_then(Value::as_object)
                .map(|props| {
                    props
                        .iter()
                        .map(|(k, v)| Node::compile(v).map(|n| (k.clone(), n)))
                        .collect::<Result<_, _>>()
                })
                .transpose()?
                .unwrap_or_default(),
            required: schema
                .get("required")
                .and_then(Value::as_array)
                .map(|keys| {
                    keys.iter()
                        .map(|k| {
                            k.as_str()
                                .map(str::to_owned)
                                .ok_or_else(|| "required entries must be strings".to_string())
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?
                .unwrap_or_default(),
            additional: match schema.get("additionalProperties") {
                None | Some(Value::Bool(true)) => Additional::Allow,
                Some(Value::Bool(false)) => Additional::Deny,
                Some(value) => Additional::Schema(Box::new(Node::compile(value)?)),
            },
            property_names: child("propertyNames")?,
            items: child("items")?,
            min_items: size(schema, "minItems")?,
            max_items: size(schema, "maxItems")?,
            any_of: variants(schema, "anyOf")?,
            one_of: variants(schema, "oneOf")?,
            default: schema.get("default").cloned(),
        })
    }

    /// First violation as `path: message`, or `Ok` when `value` satisfies the schema.
    pub fn validate(&self, value: &Value, path: &str) -> Result<(), String> {
        let fail = |message: String| {
            Err(format!(
                "{}: {message}",
                if path.is_empty() { "(root)" } else { path }
            ))
        };
        if let Some(types) = &self.types
            && !types.iter().any(|t| matches_type(*t, value))
        {
            return fail(format!("expected type {}", type_names(types)));
        }
        if let Some(values) = &self.enumeration
            && !values.contains(value)
        {
            return fail("value is not one of the allowed options".into());
        }
        if let Some(constant) = &self.constant
            && constant != value
        {
            return fail(format!("expected {constant}"));
        }
        match value {
            Value::String(s) => {
                let length = s.encode_utf16().count();
                if self.min_length.is_some_and(|min| length < min) {
                    return fail(format!(
                        "must contain at least {} character(s)",
                        self.min_length.unwrap()
                    ));
                }
                if self.max_length.is_some_and(|max| length > max) {
                    return fail(format!(
                        "must contain at most {} character(s)",
                        self.max_length.unwrap()
                    ));
                }
                if self.pattern.as_ref().is_some_and(|p| !p.is_match(s)) {
                    return fail("does not match the required pattern".into());
                }
                if self.uuid_format && !is_uuid(s) {
                    return fail("must be a uuid".into());
                }
            }
            Value::Number(n) => {
                // 超出 f64 精度的大整数不能退化成 NaN 后跳过范围检查。
                let n = n.as_f64().ok_or_else(|| {
                    format!(
                        "{}: number is out of range",
                        if path.is_empty() { "(root)" } else { path }
                    )
                })?;
                if self.minimum.is_some_and(|min| n < min)
                    || self.maximum.is_some_and(|max| n > max)
                    || self.exclusive_minimum.is_some_and(|min| n <= min)
                {
                    return fail("number is out of range".into());
                }
            }
            Value::Array(items) => {
                if self.min_items.is_some_and(|min| items.len() < min)
                    || self.max_items.is_some_and(|max| items.len() > max)
                {
                    return fail("array length is out of range".into());
                }
                if let Some(schema) = &self.items {
                    for (index, item) in items.iter().enumerate() {
                        schema.validate(item, &format!("{path}/{index}"))?;
                    }
                }
            }
            Value::Object(map) => {
                for key in &self.required {
                    if !map.contains_key(key) {
                        return fail(format!("missing required property {key}"));
                    }
                }
                for (key, item) in map {
                    let child_path = format!("{path}/{key}");
                    if let Some(names) = &self.property_names {
                        names.validate(&Value::String(key.clone()), &child_path)?;
                    }
                    match self.properties.iter().find(|(name, _)| name == key) {
                        Some((_, schema)) => schema.validate(item, &child_path)?,
                        None => match &self.additional {
                            Additional::Allow => {}
                            Additional::Deny => {
                                return fail(format!("unrecognized property {key}"));
                            }
                            Additional::Schema(schema) => schema.validate(item, &child_path)?,
                        },
                    }
                }
            }
            _ => {}
        }
        if !self.any_of.is_empty() && !self.any_of.iter().any(|n| n.validate(value, path).is_ok()) {
            return fail("does not match any allowed variant".into());
        }
        if !self.one_of.is_empty()
            && self
                .one_of
                .iter()
                .filter(|n| n.validate(value, path).is_ok())
                .count()
                != 1
        {
            return fail("must match exactly one allowed variant".into());
        }
        Ok(())
    }
}

fn variants(schema: &Value, key: &str) -> Result<Vec<Node>, String> {
    schema
        .get(key)
        .and_then(Value::as_array)
        .map(|nodes| nodes.iter().map(Node::compile).collect::<Result<_, _>>())
        .transpose()
        .map(Option::unwrap_or_default)
}

/// RFC 9562 uuid，与 zod `.uuid()` 接受的范围一致（含 nil 与 max）。
fn is_uuid(s: &str) -> bool {
    let hex = |c: char| c.is_ascii_hexdigit();
    match s.len() {
        45 if s == "ffffffff-ffff-ffff-ffff-ffffffffffff" => return true,
        36 => {}
        38 if s.starts_with('{') && s.ends_with('}') => return is_uuid(&s[1..37]),
        _ => return false,
    }
    let b = s.as_bytes();
    if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
        return false;
    }
    let groups = [&s[0..8], &s[9..13], &s[14..18], &s[19..23], &s[24..36]];
    if groups.iter().any(|g| !g.chars().all(hex)) {
        return false;
    }
    // version 1-8 且 variant 为 8/9/a/b（RFC 9562），与 zod 一致。
    matches!(s.as_bytes()[14], b'1'..=b'8')
        && matches!(s.as_bytes()[19], b'8' | b'9' | b'a' | b'A' | b'b' | b'B')
}

fn matches_type(ty: Ty, value: &Value) -> bool {
    match ty {
        Ty::String => value.is_string(),
        Ty::Number => value.is_number(),
        Ty::Integer => value
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && n.is_finite()),
        Ty::Boolean => value.is_boolean(),
        Ty::Object => value.is_object(),
        Ty::Array => value.is_array(),
        Ty::Null => value.is_null(),
    }
}

fn type_names(types: &[Ty]) -> String {
    types
        .iter()
        .map(|t| match t {
            Ty::String => "string",
            Ty::Number => "number",
            Ty::Integer => "integer",
            Ty::Boolean => "boolean",
            Ty::Object => "object",
            Ty::Array => "array",
            Ty::Null => "null",
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

#[cfg(test)]
#[path = "json_schema_tests.rs"]
mod tests;
