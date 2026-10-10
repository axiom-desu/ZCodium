//! Minimal JSON Schema validator for the keyword subset emitted by zod's
//! `toJSONSchema` for the V4 command contract.
//!
//! Compilation rejects any keyword outside the supported subset, so a new zod
//! construct surfaces as a failing test instead of being silently ignored.
//! String lengths use UTF-16 code units to match zod (JavaScript `length`).
//!
//! `pattern` uses Rust regex; unsupported JS-only patterns fail closed at compile time.
#[path = "json_schema_strip.rs"]
mod json_schema_strip;
use regex::Regex;
use serde_json::Value;
mod schema_shape;
mod string_support;
pub use string_support::{js_is_trim_space, js_json_equal, js_trim, js_trim_value};
mod type_support;
use type_support::{matches_type, type_names};

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
    trim: bool,
}

const SUPPORTED: &[&str] = &[
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
        // 已认识的约束形状异常时不能当作缺省值忽略，否则会静默削弱校验。
        schema_shape::validate(object)?;
        if let Some(format) = schema.get("format").and_then(Value::as_str) {
            if format != "uuid" {
                return Err(format!("unsupported format {format}"));
            }
            if schema.get("pattern").and_then(Value::as_str).is_none() {
                return Err("format uuid requires a string pattern".into());
            }
        }
        if schema
            .get("x-zcode-trim")
            .is_some_and(|value| value != true)
        {
            return Err("x-zcode-trim must be true".into());
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
            trim: schema
                .get("x-zcode-trim")
                .is_some_and(|value| value == true),
        })
    }

    /// Apply the bounded command-schema normalizers before validation.
    pub fn normalize(&self, value: &Value) -> Result<Value, String> {
        if !self.any_of.is_empty() || !self.one_of.is_empty() {
            let variants = self.one_of.iter().chain(&self.any_of).collect::<Vec<_>>();
            if !variants.is_empty() {
                let mut failures = Vec::new();
                for variant in variants {
                    let candidate = variant.normalize(value)?;
                    if variant.validate(&candidate, "").is_ok() {
                        return Ok(candidate);
                    }
                    failures.push(candidate);
                }
                return Ok(failures.into_iter().next().unwrap_or_else(|| value.clone()));
            }
        }
        if self.trim
            && let Some(text) = value.as_str()
        {
            return Ok(Value::String(js_trim_value(text)));
        }
        match value {
            Value::Object(map) => {
                let mut normalized = map.clone();
                for (key, child) in &self.properties {
                    if let Some(value) = map.get(key) {
                        normalized.insert(key.clone(), child.normalize(value)?);
                    }
                }
                if let Additional::Schema(child) = &self.additional {
                    for (key, value) in map {
                        if !self.properties.iter().any(|(name, _)| name == key) {
                            normalized.insert(key.clone(), child.normalize(value)?);
                        }
                    }
                }
                Ok(Value::Object(normalized))
            }
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .map(|item| {
                        self.items
                            .as_ref()
                            .map_or_else(|| Ok(item.clone()), |schema| schema.normalize(item))
                    })
                    .collect::<Result<_, String>>()?,
            )),
            _ => Ok(value.clone()),
        }
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
            && !values
                .iter()
                .any(|candidate| js_json_equal(candidate, value))
        {
            return fail("value is not one of the allowed options".into());
        }
        if let Some(constant) = &self.constant
            && !js_json_equal(constant, value)
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
            }
            Value::Number(n) => {
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

#[cfg(test)]
#[path = "json_schema_tests.rs"]
mod tests;
