//! Request header precedence and gateway routing (Node `model-execution.ts`,
//! `runner-options.ts`, `official-coding-plan-gateway.ts`).
use super::*;
use crate::contract::RequestKind;
use crate::http_fixture::{
    Bounded, Fixture, Reply, Response, expect_cancelled, expect_text_event, http_model,
    is_retry_scheduled, model as fixture_http_model, sink,
};
use serde_json::json;

const CHAT_OK: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

fn model(api: &str, base: &str, headers: &[(&str, &str)]) -> HttpModel {
    let mut config: ModelConfig = serde_json::from_value(json!({
        "providerId": "p", "modelId": "m", "reasoningLevel": "none",
        "baseUrl": base, "apiType": api,
    }))
    .unwrap();
    config.headers = headers
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect();
    http_model(config)
}

fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v)
}

fn origin() -> RequestOrigin {
    RequestOrigin {
        kind: RequestKind::Main,
        session_id: Some("sess_abc".into()),
        trace_id: "trace-1".into(),
        query_id: Some("query_q1".into()),
        query_source: "main_turn",
        stream_recovery: None,
    }
}

#[test]
fn provider_and_request_auth_headers_override_identity_but_not_attribution() {
    let model = model(
        "openai-chat-completions",
        "https://openrouter.ai/api/v1",
        &[
            ("x-title", "Provider Title"),
            ("X-ZCode-Trace-Id", "forged"),
        ],
    );
    let auth =
        json!({"requestAuth":{"headers":{"X-TITLE":"Auth Title","authorization":"Token t"}}});
    let headers = model
        .headers(Some("key"), &auth, &origin(), &mut Attempt::new(1))
        .unwrap();
    assert_eq!(header(&headers, "x-title"), Some("Auth Title"));
    assert_eq!(header(&headers, "authorization"), Some("Token t"));
    assert_eq!(header(&headers, "user-agent"), Some("ZCode/2.0.0"));
    assert_eq!(header(&headers, "X-OpenRouter-Title"), Some("ZCode"));
    assert_eq!(header(&headers, "x-zcode-trace-id"), Some("trace-1"));
    assert_eq!(header(&headers, "x-zcode-session-type"), Some("main"));
    assert_eq!(header(&headers, "x-query-id"), Some("q1"));
    assert_eq!(header(&headers, "x-session-id"), Some("abc"));
    let names: Vec<String> = headers.iter().map(|(n, _)| n.to_lowercase()).collect();
    let unique: std::collections::BTreeSet<_> = names.iter().collect();
    assert_eq!(names.len(), unique.len(), "{names:?}");
    // 每次尝试都有新的 x-request-id。
    let again = model
        .headers(Some("key"), &auth, &origin(), &mut Attempt::new(1))
        .unwrap();
    assert_ne!(
        header(&headers, "x-request-id"),
        header(&again, "x-request-id")
    );
}

#[test]
fn anthropic_adds_bearer_only_without_explicit_authorization() {
    let plain = model("anthropic-messages", "https://example.invalid", &[]);
    let headers = plain
        .headers(Some("k"), &Value::Null, &origin(), &mut Attempt::new(1))
        .unwrap();
    assert_eq!(header(&headers, "x-api-key"), Some("k"));
    assert_eq!(header(&headers, "authorization"), Some("Bearer k"));
    assert_eq!(header(&headers, "anthropic-version"), Some("2023-06-01"));
    let explicit = model(
        "anthropic-messages",
        "https://example.invalid",
        &[("Authorization", "Custom c")],
    );
    let headers = explicit
        .headers(Some("k"), &Value::Null, &origin(), &mut Attempt::new(1))
        .unwrap();
    assert_eq!(header(&headers, "authorization"), Some("Custom c"));
}

#[test]
fn official_coding_plan_endpoints_go_through_the_gateway_without_host() {
    let model = model(
        "anthropic-messages",
        "https://api.z.ai/api/anthropic",
        &[("Host", "api.z.ai")],
    );
    assert_eq!(
        model.url,
        "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages"
    );
    let headers = model
        .headers(None, &Value::Null, &origin(), &mut Attempt::new(1))
        .unwrap();
    assert_eq!(header(&headers, "host"), None);
    let direct = self::model("anthropic-messages", "https://example.invalid", &[]);
    assert_eq!(direct.url, "https://example.invalid/v1/messages");
}

#[tokio::test]
async fn local_sse_fixtures_cover_all_protocols_and_terminal_error() {
    use crate::contract::ModelPort;
    use tokio_util::sync::CancellationToken;

    async fn request(api: &str, stream: &'static str) -> Result<serde_json::Value> {
        let fixture = Fixture::start(move |_| Reply::Close(Response::sse(stream))).await;
        let deadline = Bounded::new();
        let (event_sink, _events) = sink();
        let result = deadline
            .run(
                "protocol fixture call",
                fixture_http_model(fixture.addr(), api, 0).complete(
                    vec![json!({"role":"user","content":"hi"})],
                    &[],
                    &event_sink,
                    &CancellationToken::new(),
                ),
            )
            .await
            .map(|output| output.message);
        fixture
            .finish(&deadline)
            .await
            .assert_attempts("protocol fixture", 1, 1);
        result
    }

    let chat = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    assert_eq!(
        request("openai-chat-completions", chat).await.unwrap()["content"],
        "ok"
    );
    let responses = "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"m1\",\"type\":\"message\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"m1\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"m1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"id\":\"m1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}],\"usage\":{}}}\n\n";
    assert_eq!(
        request("openai-responses", responses).await.unwrap()["content"],
        "ok"
    );
    let anthropic = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    assert_eq!(
        request("anthropic-messages", anthropic).await.unwrap()["content"],
        "ok"
    );
    let error = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"fixture rejection\"}}}\n\n";
    assert!(request("openai-responses", error).await.is_err());
}

#[tokio::test]
async fn local_http_retry_then_success_and_inflight_cancellation() {
    use crate::contract::ModelPort;
    use tokio_util::sync::CancellationToken;

    // 503 后成功：确认恰好 2 次请求。
    let fixture = Fixture::start(|number| {
        if number == 0 {
            Reply::Close(Response::new(503).header("Retry-After", "0"))
        } else {
            Reply::Close(Response::sse(CHAT_OK))
        }
    })
    .await;
    let deadline = Bounded::new();
    let (event_sink, _events) = sink();
    let output = deadline
        .run(
            "retry then success",
            fixture_http_model(fixture.addr(), "openai-chat-completions", 1).complete(
                vec![json!({"role":"user","content":"hi"})],
                &[],
                &event_sink,
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("retry-then-success call failed");
    assert_eq!(output.message["content"], "ok");
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("retry then success", 2, 2);

    // 流中取消：只发生 1 次请求、无 retry；server 干净 join。
    let fixture = Fixture::start(|_| {
        Reply::Hold(Response::sse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"stream started\"}}]}\n\n",
        ))
    })
    .await;
    let (event_sink, mut events) = sink();
    let cancel = CancellationToken::new();
    let request_cancel = cancel.clone();
    let call = tokio::spawn({
        let model = fixture_http_model(fixture.addr(), "openai-chat-completions", 3);
        async move {
            model
                .complete(
                    vec![json!({"role":"user","content":"hi"})],
                    &[],
                    &event_sink,
                    &request_cancel,
                )
                .await
        }
    });
    // 以收到模型文本事件作为“已进入流读取”的同步点，不用 sleep。
    let text = expect_text_event(&deadline, &mut events).await;
    assert_eq!(text, "stream started");
    cancel.cancel();
    let failure = expect_cancelled(
        deadline
            .run("cancelled inflight call", call)
            .await
            .expect("cancelled inflight task panicked"),
    );
    assert_eq!(failure.reason, "cancelled");
    while let Ok(event) = events.try_recv() {
        assert!(!is_retry_scheduled(&event));
    }
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("inflight cancellation", 1, 1);
}

#[test]
fn non_string_request_auth_headers_fail_authentication() {
    let model = model("openai-responses", "https://example.invalid", &[]);
    let auth = json!({"requestAuth":{"headers":{"x":1}}});
    let failure = model
        .headers(None, &auth, &origin(), &mut Attempt::new(1))
        .unwrap_err();
    assert_eq!(failure.reason, "auth_failed");
}
