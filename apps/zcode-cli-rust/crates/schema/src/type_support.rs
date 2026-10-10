use super::Ty;
use serde_json::Value;

pub(super) fn matches_type(ty: Ty, value: &Value) -> bool {
    match ty {
        Ty::String => value.is_string(),
        Ty::Number => value.is_number(),
        Ty::Integer => value
            .as_f64()
            .is_some_and(|number| number.fract() == 0.0 && number.is_finite()),
        Ty::Boolean => value.is_boolean(),
        Ty::Object => value.is_object(),
        Ty::Array => value.is_array(),
        Ty::Null => value.is_null(),
    }
}

pub(super) fn type_names(types: &[Ty]) -> String {
    types
        .iter()
        .map(|ty| match ty {
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
