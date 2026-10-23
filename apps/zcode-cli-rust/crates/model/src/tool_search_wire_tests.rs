//! 真实回环 HTTP 的模型侧 wire/失败分类用例：native ToolSearch 字段、
//! 发送前拒绝非 Anthropic、空输出的上下文超窗与失败 usage、partial 保留。
use super::*;
use crate::contract::{
    Event, ModelPort, ModelRequestOptions, RequestKind, RequestOrigin, RunEvent,
};
use crate::http_fixture::{
    Bounded, Fixture, Reply, Response, http_model, model as fixture_model, sink,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const ANTHROPIC_OK: &str = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
const CHAT_OK: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

/// 请求体（JSON）与头部断言都只看真实字节，不看内部结构。
fn body_of(raw: &str) -> Value {
    let (_, body) = raw.split_once("\r\n\r\n").expect("request body");
    serde_json::from_str(body).expect("json request body")
}

fn header_of(raw: &str, name: &str) -> Option<String> {
    raw.split("\r\n")
        .take_while(|line| !line.is_empty())
        .find_map(|line| {
            let (header, value) = line.split_once(':')?;
            header
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
}

fn origin() -> std::sync::Arc<RequestOrigin> {
    std::sync::Arc::new(RequestOrigin {
        kind: RequestKind::Main,
        session_id: Some("s".into()),
        trace_id: "t".into(),
        query_id: None,
        query_source: "main_turn",
        stream_recovery: None,
    })
}

fn scoped_sink() -> (crate::contract::EventSink, mpsc::Receiver<RunEvent>) {
    let (mut event_sink, events) = sink();
    event_sink.origin = origin();
    (event_sink, events)
}

fn deferred_tools() -> Vec<Value> {
    vec![
        json!({"type":"function","function":{"name":"Bash","description":"run","parameters":{"type":"object"}},"deferLoading":false}),
        json!({"type":"function","function":{"name":"WebFetch","description":"fetch","parameters":{"type":"object"}},"deferLoading":true}),
    ]
}

/// 一次助手工具调用 + 引用结果：引用只能出现在工具结果里。
fn reference_history() -> Vec<Value> {
    vec![
        json!({"role":"user","content":"hi"}),
        json!({"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"WebFetch","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"c1","content":[{"type":"tool_reference","toolName":"WebFetch"}]}),
    ]
}

fn failure_of(
    result: std::result::Result<crate::contract::ModelOutput, ModelFailure>,
) -> ModelFailure {
    match result {
        Ok(_) => panic!("model call unexpectedly succeeded"),
        Err(failure) => failure,
    }
}

fn statuses(events: &[RunEvent], kind: &str) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| match &event.event {
            Event::ModelStatus(status) if status["type"] == kind => Some(status.clone()),
            _ => None,
        })
        .collect()
}

async fn collect(mut events: mpsc::Receiver<RunEvent>, deadline: &Bounded) -> Vec<RunEvent> {
    let mut seen = vec![];
    while let Some(event) = deadline.run("draining model events", events.recv()).await {
        seen.push(event);
    }
    seen
}

#[tokio::test]
async fn native_anthropic_wire_carries_defer_loading_reference_and_beta() {
    let fixture = Fixture::start(|_| Reply::Close(Response::sse(ANTHROPIC_OK))).await;
    let deadline = Bounded::new();
    let (event_sink, _events) = scoped_sink();
    let output = deadline
        .run(
            "native tool search call",
            fixture_model(fixture.addr(), "anthropic-messages", 0).complete_with_options(
                reference_history(),
                &deferred_tools(),
                &ModelRequestOptions::native_tool_search(),
                &event_sink,
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("native tool search call failed");
    assert_eq!(output.message["content"], "ok");
    let requests = fixture.requests();
    let stats = fixture.finish(&deadline).await;
    stats.assert_attempts("native tool search", 1, 1);
    let raw = &requests[0];
    let body = body_of(raw);
    // 常驻工具保留完整 schema 且不带 defer_loading；已发现 deferred schema 标延迟。
    assert_eq!(body["tools"][0]["name"], "Bash");
    assert_eq!(body["tools"][0].get("defer_loading"), None);
    assert_eq!(body["tools"][1]["name"], "WebFetch");
    assert_eq!(body["tools"][1]["defer_loading"], true);
    assert_eq!(body["tools"][1]["input_schema"]["type"], "object");
    // 工具结果引用走 HTTP 字段 `tool_name`，不能泄漏内部 `toolName`。
    let text = body.to_string();
    assert!(text.contains("tool_reference"), "{text}");
    assert!(text.contains("\"tool_name\""), "{text}");
    assert!(!text.contains("toolName"), "{text}");
    // beta 真实落在请求头上。
    let beta = header_of(raw, "anthropic-beta").expect("anthropic-beta header");
    assert!(beta.contains(super::BETA), "{beta}");
}

#[tokio::test]
async fn native_options_are_rejected_before_any_http_request() {
    let fixture = Fixture::start(|_| Reply::Close(Response::sse(CHAT_OK))).await;
    let deadline = Bounded::new();
    let (event_sink, _events) = scoped_sink();
    let failure = failure_of(
        deadline
            .run(
                "rejected native call",
                fixture_model(fixture.addr(), "openai-chat-completions", 0).complete_with_options(
                    vec![json!({"role":"user","content":"hi"})],
                    &deferred_tools(),
                    &ModelRequestOptions::native_tool_search(),
                    &event_sink,
                    &CancellationToken::new(),
                ),
            )
            .await,
    );
    assert_eq!(failure.reason, "tool_search_unsupported");
    assert!(!failure.retryable);
    // 发送前拒绝：没有任何物理请求。
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("rejected native", 0, 0);
}

#[tokio::test]
async fn empty_context_window_exceeded_is_a_context_error_with_usage_once() {
    // 单次写完整 SSE（等价非流式响应）也必须是失败而不是 output-limit 续写。
    let stream = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":120000,\"output_tokens\":0}}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"model_context_window_exceeded\"},\"usage\":{\"output_tokens\":0}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    let fixture = Fixture::start(move |_| Reply::Close(Response::sse(stream))).await;
    let deadline = Bounded::new();
    let (event_sink, events) = scoped_sink();
    let failure = failure_of(
        deadline
            .run(
                "context exceeded call",
                fixture_model(fixture.addr(), "anthropic-messages", 2).complete(
                    vec![json!({"role":"user","content":"hi"})],
                    &[],
                    &event_sink,
                    &CancellationToken::new(),
                ),
            )
            .await,
    );
    assert_eq!(failure.reason, "context_exceeded");
    assert!(!failure.retryable);
    assert!(!failure.empty_completion);
    // provider 原始 usage（Anthropic 已翻译为 prompt_tokens）。
    assert_eq!(
        failure.usage.as_ref().unwrap()["prompt_tokens"],
        json!(120000)
    );
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("context exceeded", 1, 1);
    // sink 仍持有发送端：先释放再 drain，用 channel 关闭作为终止条件而不是 sleep。
    drop(event_sink);
    let events = collect(events, &deadline).await;
    let failed = statuses(&events, "model_request_failed");
    assert_eq!(failed.len(), 1, "terminal failure reported once");
    assert_eq!(failed[0]["usage"]["inputTokens"], json!(120000));
    assert_eq!(failed[0]["reason"], json!("context_exceeded"));
    // 成功终态不能同时出现：失败用量只结算一次。
    assert!(statuses(&events, "model_request_completed").is_empty());
}

#[tokio::test]
async fn partial_output_keeps_context_window_exceeded_as_output_limit() {
    // 分段到达（chunked）的 partial 输出必须保留原续写语义，不转成异常。
    let stream = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7}}}\n\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"model_context_window_exceeded\"},\"usage\":{\"output_tokens\":3}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    let fixture = Fixture::start(move |_| Reply::Hold(Response::sse(stream))).await;
    let deadline = Bounded::new();
    let (event_sink, _events) = scoped_sink();
    let output = deadline
        .run(
            "partial context exceeded call",
            fixture_model(fixture.addr(), "anthropic-messages", 0).complete(
                vec![json!({"role":"user","content":"hi"})],
                &[],
                &event_sink,
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("partial output call failed");
    assert_eq!(output.message["content"], "partial");
    assert!(output.output_limit);
    assert_eq!(
        output.raw_finish_reason.as_deref(),
        Some("model_context_window_exceeded")
    );
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("partial context exceeded", 1, 1);
}

#[tokio::test]
async fn refusal_and_content_filter_are_not_retried_as_empty() {
    // Anthropic refusal（非原生工具请求）与 Chat content_filter 都是明确原因，
    // 不能落进空响应重试：每次只有一次物理请求，且失败不可重试。
    let refusal = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"},\"usage\":{\"output_tokens\":0}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
    let fixture = Fixture::start(move |_| Reply::Close(Response::sse(refusal))).await;
    let deadline = Bounded::new();
    let (event_sink, _events) = scoped_sink();
    let failure = failure_of(
        deadline
            .run(
                "refusal call",
                fixture_model(fixture.addr(), "anthropic-messages", 2).complete(
                    vec![json!({"role":"user","content":"hi"})],
                    &[],
                    &event_sink,
                    &CancellationToken::new(),
                ),
            )
            .await,
    );
    assert_eq!(failure.reason, "invalid_response");
    assert!(!failure.retryable);
    assert!(!failure.empty_completion);
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("refusal", 1, 1);

    let filtered = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\ndata: [DONE]\n\n";
    let fixture = Fixture::start(move |_| Reply::Close(Response::sse(filtered))).await;
    let (event_sink, _events) = scoped_sink();
    let failure = failure_of(
        deadline
            .run(
                "content filter call",
                fixture_model(fixture.addr(), "openai-chat-completions", 2).complete(
                    vec![json!({"role":"user","content":"hi"})],
                    &[],
                    &event_sink,
                    &CancellationToken::new(),
                ),
            )
            .await,
    );
    assert!(!failure.empty_completion);
    assert!(!failure.retryable);
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("content filter", 1, 1);
}

#[tokio::test]
async fn raw_finish_reason_falls_back_to_provider_metadata() {
    // Chat 协议把真实原因放在 provider metadata：空输出 + 上下文超窗同样要分类成功。
    let stream = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}],\"provider_metadata\":{\"rawFinishReason\":\"model_context_window_exceeded\"},\"usage\":{\"prompt_tokens\":64000,\"completion_tokens\":0,\"total_tokens\":64000}}\n\ndata: [DONE]\n\n";
    let fixture = Fixture::start(move |_| Reply::Close(Response::sse(stream))).await;
    let deadline = Bounded::new();
    let (event_sink, events) = scoped_sink();
    let failure = failure_of(
        deadline
            .run(
                "provider metadata raw finish",
                fixture_model(fixture.addr(), "openai-chat-completions", 2).complete(
                    vec![json!({"role":"user","content":"hi"})],
                    &[],
                    &event_sink,
                    &CancellationToken::new(),
                ),
            )
            .await,
    );
    assert_eq!(failure.reason, "context_exceeded");
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("provider metadata raw finish", 1, 1);
    drop(event_sink);
    let events = collect(events, &deadline).await;
    let failed = statuses(&events, "model_request_failed");
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0]["usage"]["inputTokens"], json!(64000));
    assert_eq!(failed[0]["usage"]["totalTokens"], json!(64000));
}

#[tokio::test]
async fn capability_is_reported_from_provider_config() {
    let coding_plan: crate::config::ModelConfig = serde_json::from_value(json!({
        "providerId":"p","modelId":"m","reasoningLevel":"none",
        "baseUrl":"https://example.invalid","apiType":"anthropic-messages"
    }))
    .unwrap();
    let mut coding_plan = coding_plan;
    coding_plan.access_type = Some("zhipu-coding-plan-api-key".into());
    let capability = http_model(coding_plan)
        .tool_search_capability()
        .expect("capability reported");
    assert!(capability.protocol_supported);
    assert!(capability.default_enabled);
}
