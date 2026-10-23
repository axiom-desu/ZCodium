use super::*;
use serde_json::json;

fn config(api: &str, access_type: &str, access_mode: Option<&str>) -> ModelConfig {
    let mut config: ModelConfig = serde_json::from_value(json!({
        "providerId":"fixture","modelId":"fixture","reasoningLevel":"none",
        "baseUrl":"https://example.invalid","apiType":api
    }))
    .unwrap();
    config.access_type = Some(access_type.into());
    config.access_mode = access_mode.map(str::to_owned);
    config
}

#[test]
fn capability_reads_actual_non_secret_access() {
    // Node `resolveToolSearchCapability`：协议支持只看 Anthropic Messages，
    // defaultEnabled 还要求真实 coding-plan 访问方式。
    let coding_plan = config("anthropic-messages", "zhipu-coding-plan-api-key", None);
    let capability = super::capability(&coding_plan);
    assert!(capability.protocol_supported);
    assert!(capability.default_enabled);

    let plain_key = config("anthropic-messages", "api-key", None);
    assert!(super::capability(&plain_key).protocol_supported);
    assert!(!super::capability(&plain_key).default_enabled);

    let account = config(
        "anthropic-messages",
        "zhipu-account",
        Some("individual-coding-plan"),
    );
    assert!(super::capability(&account).default_enabled);
    let team = config(
        "anthropic-messages",
        "zhipu-account",
        Some("team-coding-plan"),
    );
    assert!(super::capability(&team).default_enabled);
    let standard = config("anthropic-messages", "zhipu-account", Some("standard"));
    assert!(!super::capability(&standard).default_enabled);

    // 非 Anthropic 即使 access 是 coding plan 也不能声称协议支持。
    let chat = config("openai-chat-completions", "zhipu-coding-plan-api-key", None);
    let capability = super::capability(&chat);
    assert!(!capability.protocol_supported);
    assert!(!capability.default_enabled);
}

#[test]
fn native_options_are_rejected_on_non_anthropic_protocols() {
    assert!(super::ensure_native(&config("anthropic-messages", "api-key", None)).is_ok());
    for api in ["openai-chat-completions", "openai-responses"] {
        let failure = super::ensure_native(&config(api, "api-key", None)).unwrap_err();
        assert_eq!(failure.reason, "tool_search_unsupported");
        assert_eq!(failure.code, "invalid_model_request");
        assert!(!failure.retryable);
    }
}

#[test]
fn anthropic_tools_defer_only_contract_marked_tools() {
    let tools = [
        json!({"type":"function","function":{"name":"Bash","description":"d","parameters":{}},"deferLoading":false}),
        json!({"type":"function","function":{"name":"WebFetch","description":"d","parameters":{"type":"object"}},"deferLoading":true}),
    ];
    let native = super::anthropic_tools(&tools, true);
    // 完整 schema 保留，只有契约里 deferLoading 的工具带 defer_loading。
    assert_eq!(native[0].get("defer_loading"), None);
    assert_eq!(native[1]["defer_loading"], true);
    assert_eq!(native[1]["name"], "WebFetch");
    assert_eq!(native[1]["input_schema"]["type"], "object");
    // 非 native 请求不携带任何 defer_loading。
    assert!(
        super::anthropic_tools(&tools, false)
            .iter()
            .all(|tool| tool.get("defer_loading").is_none())
    );
}

#[test]
fn tool_reference_maps_internal_name_to_wire_field() {
    assert_eq!(
        super::tool_reference(&json!({"type":"tool_reference","toolName":"WebFetch"})),
        Some(json!({"type":"tool_reference","tool_name":"WebFetch"}))
    );
    assert_eq!(
        super::tool_reference(&json!({"type":"tool_reference","toolName":""})),
        None
    );
}

#[test]
fn beta_header_appends_without_losing_other_values() {
    let mut headers = Headers::default();
    super::append_beta(&mut headers, super::WEB_SEARCH_BETA);
    headers.set(
        "Anthropic-Beta",
        format!("{},{BETA}", super::WEB_SEARCH_BETA),
    );
    // 大小写不同的同名 header 只保留一个 key，值按逗号去重且不覆盖既有 beta。
    super::append_beta(&mut headers, super::BETA);
    let merged = headers.get("anthropic-beta").unwrap();
    assert_eq!(
        merged,
        format!("{},{}", super::WEB_SEARCH_BETA, super::BETA)
    );
    assert_eq!(
        headers
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case("anthropic-beta"))
            .count(),
        1
    );
}
