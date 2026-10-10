use serde_json::Value;

/// JavaScript String.prototype.trim whitespace set, including FEFF and NBSP.
pub fn js_is_trim_space(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(js_is_trim_space)
}

/// Owned form for JSON normalization, which replaces the original string value.
pub fn js_trim_value(value: &str) -> String {
    js_trim(value).to_owned()
}

/// Compare parsed JSON values using JavaScript Number equality.
pub fn js_json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        },
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| js_json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| js_json_equal(value, other)))
        }
        _ => left == right,
    }
}
