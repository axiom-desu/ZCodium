//! Tests for the zod-subset JSON Schema validator.
use super::*;
use serde_json::json;

#[test]
fn strip_matches_zod_output_modes() {
    let node = Node::compile(&json!({
        "type":"object",
        "properties":{
            "strict":{"type":"object","properties":{"a":{"type":"number"}}},
            "loose":{"type":"object","properties":{"a":{"type":"number"}},"additionalProperties":{}},
            "any":{}
        },
        "additionalProperties":{}
    }))
    .unwrap();
    let value = json!({"strict":{"a":1,"x":2},"loose":{"a":1,"x":2},"any":{"x":2},"top":true});
    assert_eq!(
        node.strip(&value),
        json!({"strict":{"a":1},"loose":{"a":1,"x":2},"any":{"x":2},"top":true})
    );
}

#[test]
fn rejects_unsupported_keywords_at_compile_time() {
    assert!(Node::compile(&json!({"type":"string","allOf":[]})).is_err());
    assert!(Node::compile(&json!({"type":"string","format":"email"})).is_err());
    assert!(Node::compile(&json!({"type":"string","format":"uuid"})).is_err());
}

#[test]
fn rejects_malformed_recognized_schema_keywords() {
    for malformed in [
        json!({"properties": []}),
        json!({"required": "name"}),
        json!({"enum": "name"}),
        json!({"anyOf": {}}),
        json!({"oneOf": "not an array"}),
        json!({"format": 7}),
        json!({"pattern": false}),
        json!({"type": []}),
        json!({"anyOf": []}),
        json!({"oneOf": []}),
        json!({"required": ["name", 7]}),
    ] {
        assert!(Node::compile(&malformed).is_err(), "accepted {malformed}");
    }
}

#[test]
fn recognized_metadata_does_not_gain_unrelated_shape_restrictions() {
    assert!(
        Node::compile(&json!({
            "$schema": {"metadata": true},
            "$id": 7,
            "title": [],
            "default": {"anything": [1, null]},
            "const": {"anything": [1, null]}
        }))
        .is_ok()
    );
}

#[test]
fn trim_extension_requires_a_string_schema_type() {
    for malformed in [
        json!({"x-zcode-trim": true}),
        json!({"type": "number", "x-zcode-trim": true}),
        json!({"type": ["string", "null"], "x-zcode-trim": true}),
    ] {
        assert!(Node::compile(&malformed).is_err(), "accepted {malformed}");
    }
}

#[test]
fn validates_zod_subset_semantics() {
    let node = Node::compile(&json!({
        "type":"object",
        "properties":{
            "name":{"type":"string","minLength":1,"maxLength":2},
            "count":{"type":"integer","exclusiveMinimum":0,"maximum":100},
            "mode":{"type":"string","enum":["a","b"]},
            "tags":{"type":"array","items":{"type":"string"},"maxItems":1},
            "either":{"anyOf":[{"type":"string"},{"type":"null"}]},
            "one":{"oneOf":[{"type":"object","properties":{"k":{"const":"a"}},"required":["k"]},{"type":"object","properties":{"k":{"const":"b"}},"required":["k"]}]},
            "map":{"type":"object","propertyNames":{"type":"string","minLength":2},"additionalProperties":{"type":"number"}}
        },
        "required":["name"],
        "additionalProperties":false
    }))
    .unwrap();
    assert!(
        node.validate(
            &json!({"name":"ok","count":3,"mode":"a","tags":["x"],"either":null,"map":{"kk":1}}),
            ""
        )
        .is_ok()
    );
    for bad in [
        json!({}),
        json!({"name":""}),
        json!({"name":"😀😀"}),
        json!({"name":"a","count":0}),
        json!({"name":"a","count":1.5}),
        json!({"name":"a","mode":"c"}),
        json!({"name":"a","tags":["x","y"]}),
        json!({"name":"a","either":1}),
        json!({"name":"a","map":{"k":1}}),
        json!({"name":"a","map":{"kk":"x"}}),
        json!({"name":"a","extra":true}),
        json!({"name":"a","one":{"k":"c"}}),
    ] {
        assert!(node.validate(&bad, "").is_err(), "{bad}");
    }
}

#[test]
fn trim_extension_matches_javascript_whitespace_and_union_candidate() {
    let node = Node::compile(&json!({
        "anyOf":[
            {"type":"object","properties":{"value":{"type":"string","x-zcode-trim":true,"minLength":1}},"required":["value"],"additionalProperties":false},
            {"type":"object","properties":{"other":{"type":"number"}},"required":["other"],"additionalProperties":false}
        ]
    })).unwrap();
    for (input, expected) in [
        ("\u{feff}\u{00a0} hello \u{00a0}", "hello"),
        ("  A b  ", "A b"),
        ("\u{feff}\u{00a0}", ""),
    ] {
        let source = json!({"value":input});
        let normalized = node.normalize(&source).unwrap();
        assert_eq!(normalized["value"], expected);
        assert_eq!(node.validate(&normalized, "").is_ok(), !expected.is_empty());
    }
    let union = node.normalize(&json!({"other":3})).unwrap();
    assert_eq!(union, json!({"other":3}));
}

#[test]
fn enum_and_const_use_javascript_number_equality() {
    let enum_node = Node::compile(&json!({"enum":[1]})).unwrap();
    let const_node = Node::compile(&json!({"const":1.0})).unwrap();
    assert!(
        enum_node
            .validate(&serde_json::from_str("1.0").unwrap(), "")
            .is_ok()
    );
    assert!(
        const_node
            .validate(&serde_json::from_str("1").unwrap(), "")
            .is_ok()
    );
}

#[test]
fn uuid_format_uses_the_generated_pattern_as_its_only_rule() {
    let schema = json!({
        "type":"string",
        "format":"uuid",
        "pattern":"^(00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$"
    });
    let node = Node::compile(&schema).unwrap();
    for uuid in [
        "00000000-0000-0000-0000-000000000000",
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "01890a5d-ac96-774b-bcce-b302099a8057",
    ] {
        assert!(node.validate(&json!(uuid), "").is_ok());
    }
    for invalid in ["{01890a5d-ac96-774b-bcce-b302099a8057}", "not-a-uuid", "😀"] {
        assert!(node.validate(&json!(invalid), "").is_err());
    }
}

#[test]
fn strip_orders_keys_like_zod_and_fills_defaults() {
    let node = Node::compile(&json!({
        "type":"object",
        "properties":{"a":{"type":"number"},"list":{"default":[],"type":"array"},"b":{"type":"number"}},
        "additionalProperties":{}
    }))
    .unwrap();
    let out = node.strip(&json!({"extra":1,"b":2,"a":1}));
    assert_eq!(
        serde_json::to_string(&out).unwrap(),
        r#"{"a":1,"list":[],"b":2,"extra":1}"#
    );
}
