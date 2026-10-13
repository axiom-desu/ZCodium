//! Request header precedence and gateway routing (Node `model-execution.ts`,
//! `runner-options.ts`, `official-coding-plan-gateway.ts`).
use super::*;
use crate::contract::RequestKind;
use crate::network_status::Attempt;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zcode_cli_net::{NetworkPolicy, RuntimeEnv};

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
    let env = RuntimeEnv::from_vars(vec![("ZCODE_APP_VERSION".into(), "2.0.0".into())]);
    let egress = Egress::new(
        Arc::new(env),
        &NetworkPolicy::default(),
        std::path::Path::new("/nonexistent"),
        "electron",
    )
    .unwrap();
    HttpModel::new(config, Arc::new(egress))
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
    use crate::contract::{EventSink, ModelPort, RequestOrigin};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    async fn request(api: &str, stream: &'static str) -> Result<serde_json::Value> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let response = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            let body = stream.as_bytes();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            // TCP write 边界不等于客户端 read 边界；bytewise 行为由 SseDecoder 单测确定性覆盖。
            socket.write_all(body).await.unwrap();
        });
        let mut config: ModelConfig = serde_json::from_value(json!({"providerId":"fixture","modelId":"fixture","reasoningLevel":"none","baseUrl":format!("http://{addr}"),"apiType":api,"retry":{"maxRetries":0},"streamIdleTimeoutMs":5000})).unwrap();
        config.retry.max_retries = Some(0);
        let env = RuntimeEnv::from_vars(vec![]);
        let egress = Arc::new(
            Egress::new(
                Arc::new(env),
                &NetworkPolicy::default(),
                std::path::Path::new("/nonexistent"),
                "test",
            )
            .unwrap(),
        );
        let model = HttpModel::new(config, egress);
        let (tx, _rx) = mpsc::channel(128);
        let sink = EventSink {
            session_id: "s".into(),
            run_id: "r".into(),
            tx,
            origin: Arc::new(RequestOrigin::default()),
            request_auth: None,
        };
        let result = model
            .complete(
                vec![json!({"role":"user","content":"hi"})],
                &[],
                &sink,
                &CancellationToken::new(),
            )
            .await
            .map(|o| o.message);
        response.await.unwrap();
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
    use crate::contract::{EventSink, ModelPort, RequestOrigin};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;
    use tokio::sync::{mpsc, oneshot};
    use tokio_util::sync::CancellationToken;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let server = tokio::spawn(async move {
        for attempt in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 2048];
            let _ = socket.read(&mut bytes).await.unwrap();
            seen.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            } else {
                let body = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        }
    });
    let mut config: ModelConfig = serde_json::from_value(json!({"providerId":"fixture","modelId":"fixture","reasoningLevel":"none","baseUrl":format!("http://{addr}"),"retry":{"maxRetries":1,"baseDelayMs":0,"jitter":false},"streamIdleTimeoutMs":5000})).unwrap();
    config.retry.max_retries = Some(1);
    config.retry.base_delay_ms = Some(0);
    config.retry.jitter = Some(false);
    let egress = Arc::new(
        Egress::new(
            Arc::new(RuntimeEnv::from_vars(vec![])),
            &NetworkPolicy::default(),
            std::path::Path::new("/nonexistent"),
            "test",
        )
        .unwrap(),
    );
    let model = HttpModel::new(config, egress);
    let (tx, _rx) = mpsc::channel(128);
    let sink = EventSink {
        session_id: "s".into(),
        run_id: "r".into(),
        tx,
        origin: Arc::new(RequestOrigin::default()),
        request_auth: None,
    };
    let output = model
        .complete(
            vec![json!({"role":"user","content":"hi"})],
            &[],
            &sink,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(output.message["content"], "ok");
    server.await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 2);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cancellation_requests = Arc::new(AtomicUsize::new(0));
    let server_requests = cancellation_requests.clone();
    let (call_finished, mut finish_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 2048];
        let _ = socket.read(&mut bytes).await.unwrap();
        server_requests.fetch_add(1, Ordering::SeqCst);
        let body = b"data: {\"choices\":[{\"delta\":{\"content\":\"stream started\"}}]}\n\n";
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
        socket
            .write_all(format!("{:X}\r\n", body.len()).as_bytes())
            .await
            .unwrap();
        socket.write_all(body).await.unwrap();
        socket.write_all(b"\r\n").await.unwrap();

        let mut stream_open = true;
        let mut probe = [0; 1];
        loop {
            tokio::select! {
                _ = &mut finish_rx => break,
                result = socket.read(&mut probe), if stream_open => {
                    if result.unwrap() == 0 { stream_open = false; }
                }
                accepted = listener.accept() => {
                    let (mut socket, _) = accepted.unwrap();
                    let mut bytes = [0; 2048];
                    let _ = socket.read(&mut bytes).await.unwrap();
                    server_requests.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        // 逻辑调用完成后排空已经到达 accept 队列的请求，避免漏计取消后的重试。
        let listener = listener.into_std().unwrap();
        listener.set_nonblocking(true).unwrap();
        while listener.accept().is_ok() {
            server_requests.fetch_add(1, Ordering::SeqCst);
        }
    });
    let mut config: ModelConfig = serde_json::from_value(json!({"providerId":"fixture","modelId":"fixture","reasoningLevel":"none","baseUrl":format!("http://{addr}"),"retry":{"maxRetries":3,"baseDelayMs":0},"streamIdleTimeoutMs":5000})).unwrap();
    config.retry.max_retries = Some(3);
    let egress = Arc::new(
        Egress::new(
            Arc::new(RuntimeEnv::from_vars(vec![])),
            &NetworkPolicy::default(),
            std::path::Path::new("/nonexistent"),
            "test",
        )
        .unwrap(),
    );
    let model = HttpModel::new(config, egress);
    let cancel = CancellationToken::new();
    let request_cancel = cancel.clone();
    let (event_sink, mut events) = {
        let (tx, rx) = mpsc::channel(128);
        (
            EventSink {
                session_id: "s".into(),
                run_id: "r".into(),
                tx,
                origin: Arc::new(RequestOrigin::default()),
                request_auth: None,
            },
            rx,
        )
    };
    let call = tokio::spawn(async move {
        model
            .complete(
                vec![json!({"role":"user","content":"hi"})],
                &[],
                &event_sink,
                &request_cancel,
            )
            .await
    });
    let text = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = events.recv().await
                && let crate::contract::Event::Text {
                    text,
                    reasoning: false,
                    ..
                } = event.event
            {
                break text;
            }
        }
    })
    .await
    .expect("model text event was not received");
    assert_eq!(text, "stream started");
    cancel.cancel();
    let failure = tokio::time::timeout(std::time::Duration::from_secs(5), call)
        .await
        .expect("cancelled model call did not finish")
        .unwrap();
    match failure {
        Ok(_) => panic!("cancelled model call unexpectedly succeeded"),
        Err(failure) => assert_eq!(failure.reason, "cancelled"),
    }
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(
            event.event,
            crate::contract::Event::ModelStatus(status)
                if status["type"] == "model_retry_scheduled"
        ));
    }
    call_finished.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .expect("fixture server did not shut down")
        .unwrap();
    assert_eq!(cancellation_requests.load(Ordering::SeqCst), 1);
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
