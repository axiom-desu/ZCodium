//! 插件发现工具名与严格输入规则。
use super::*;
use serde_json::json;

#[test]
fn tool_names_are_the_closed_pair() {
    assert_eq!(tools(), [SEARCH, SUGGEST]);
    assert!(is_tool("SearchPlugins"));
    assert!(is_tool("SuggestPluginInstall"));
    for name in ["SearchPlugin", "Plugins", "Read"] {
        assert!(!is_tool(name), "{name}");
    }
}

#[test]
fn search_input_is_strict_and_bounded() {
    assert_eq!(
        parse_search(&json!({"query":" pdf "})).unwrap().query,
        "pdf"
    );
    assert_eq!(
        parse_search(&json!({"query":"pdf","cursor":"bm25-v1:00"}))
            .unwrap()
            .cursor,
        Some("bm25-v1:00".into())
    );
    for invalid in [
        json!(null),
        json!([]),
        json!({}),
        json!({"query":""}),
        json!({"query":"   "}),
        json!({"query":7}),
        json!({"query":"pdf","extra":1}),
        json!({"query":"pdf","cursor":5}),
    ] {
        assert!(parse_search(&invalid).is_err(), "{invalid}");
    }
}

#[test]
fn suggest_input_is_strict() {
    let parsed = parse_suggest(&json!({"pluginId":"pdf@official","reason":"needs PDF"})).unwrap();
    assert_eq!(parsed.plugin_id, "pdf@official");
    assert!(!parsed.reconsider);
    let reconsider =
        parse_suggest(&json!({"pluginId":"pdf@official","reason":"ok","reconsider":true})).unwrap();
    assert!(reconsider.reconsider);
    for invalid in [
        json!({}),
        json!({"pluginId":"pdf@official"}),
        json!({"pluginId":"","reason":"x"}),
        json!({"pluginId":"pdf@official","reason":"x","reconsider":"true"}),
        json!({"pluginId":"pdf@official","reason":"x","model":"m"}),
    ] {
        assert!(parse_suggest(&invalid).is_err(), "{invalid}");
    }
}

#[test]
fn suggestion_keeps_the_closed_status_shape() {
    assert_eq!(
        suggestion(
            "pdf@official",
            "installed",
            "ready",
            Some("refreshRequired")
        ),
        json!({"pluginId":"pdf@official","status":"installed","message":"ready",
            "activation":"refreshRequired"})
    );
    assert_eq!(
        suggestion("pdf@official", "unavailable", "no catalog", None),
        json!({"pluginId":"pdf@official","status":"unavailable","message":"no catalog"})
    );
}
