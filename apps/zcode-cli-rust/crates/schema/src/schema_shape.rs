use serde_json::{Map, Value};

/// Validate the shape of recognized keywords before compilation can treat them as absent.
pub(super) fn validate(schema: &Map<String, Value>) -> Result<(), String> {
    for key in ["properties"] {
        if schema.get(key).is_some_and(|value| !value.is_object()) {
            return Err(format!("{key} must be an object"));
        }
    }
    for key in ["required", "enum", "anyOf", "oneOf"] {
        if let Some(value) = schema.get(key) {
            let values = value
                .as_array()
                .ok_or_else(|| format!("{key} must be an array"))?;
            if values.is_empty() {
                return Err(format!("{key} must not be empty"));
            }
            if key == "required" && values.iter().any(|entry| !entry.is_string()) {
                return Err("required entries must be strings".into());
            }
        }
    }
    for key in ["format", "pattern"] {
        if schema.get(key).is_some_and(|value| !value.is_string()) {
            return Err(format!("{key} must be a string"));
        }
    }
    if let Some(value) = schema.get("type") {
        match value {
            Value::String(_) => {}
            Value::Array(values) if !values.is_empty() => {
                if values.iter().any(|entry| !entry.is_string()) {
                    return Err("type entries must be strings".into());
                }
            }
            Value::Array(_) => return Err("type must not be empty".into()),
            _ => return Err("type must be a string or array".into()),
        }
    }
    if schema.get("x-zcode-trim") == Some(&Value::Bool(true))
        && schema.get("type") != Some(&Value::String("string".into()))
    {
        return Err("x-zcode-trim requires type string".into());
    }
    Ok(())
}
