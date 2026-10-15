use crate::contract::{Event, ModelPort};
use crate::http_fixture::{
    Bounded, Fixture, Reply, Response, expect_cancelled, fixture_model, is_retry_scheduled, sink,
    wait_for_event,
};
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const CHAT_OK: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

#[tokio::test]
async fn non_retryable_http_is_not_retried_and_retry_budget_caps_attempts() {
    for (status, retries, expected) in [(400u16, 5u32, 1usize), (503, 2, 3)] {
        let fixture = Fixture::start(move |_| Reply::Close(Response::new(status))).await;
        let deadline = Bounded::new();
        let (event_sink, _events) = sink();
        let result = deadline
            .run(
                &format!("HTTP {status} call"),
                fixture_model(fixture.addr(), retries).complete(
                    vec![json!({"role":"user","content":"hi"})],
                    &[],
                    &event_sink,
                    &CancellationToken::new(),
                ),
            )
            .await;
        assert!(result.is_err(), "HTTP {status} unexpectedly succeeded");
        // accepted 与 complete 都必须等于期望 attempt 数，才能发现迟到连接。
        fixture.finish(&deadline).await.assert_attempts(
            &format!("HTTP {status}"),
            expected,
            expected,
        );
    }
}

#[tokio::test]
async fn positive_retry_after_is_honored_before_next_attempt() {
    let fixture = Fixture::start(|number| {
        if number == 0 {
            Reply::Close(Response::new(503).header("Retry-After", "1"))
        } else {
            Reply::Close(Response::sse(CHAT_OK))
        }
    })
    .await;
    let deadline = Bounded::new();
    let (event_sink, mut events) = sink();
    let result = deadline
        .run(
            "retry-after call",
            fixture_model(fixture.addr(), 1).complete(
                vec![json!({"role":"user","content":"hi"})],
                &[],
                &event_sink,
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("retry-after call failed");
    assert_eq!(result.message["content"], "ok");
    // Retry-After 排定值可单独校验：`Retry-After: 1` + `baseDelayMs=0` 应为 1000ms。
    let retry = wait_for_event(
        &deadline,
        &mut events,
        "model_retry_scheduled",
        is_retry_scheduled,
    )
    .await;
    match &retry.event {
        Event::ModelStatus(status) => assert_eq!(status["delayMs"], 1000, "scheduled delayMs"),
        _ => unreachable!("is_retry_scheduled guarantees a status event"),
    }
    // arrivals[i] 是第 i 个请求被完整读取的时刻，因此该区间包含首响应的
    // 读取与解析耗时，只是 Retry-After 等待时长的下界，不是精确退避时长。
    let arrivals = fixture.arrivals();
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("retry-after", 2, 2);
    assert_eq!(arrivals.len(), 2);
    assert!(
        arrivals[1] - arrivals[0] >= Duration::from_millis(900),
        "Retry-After lower bound violated: {:?}",
        arrivals[1] - arrivals[0]
    );
}

#[tokio::test]
async fn cancellation_during_retry_backoff_prevents_another_attempt() {
    let fixture =
        Fixture::start(|_| Reply::Close(Response::new(503).header("Retry-After", "5"))).await;
    let deadline = Bounded::new();
    let cancel = CancellationToken::new();
    let request_cancel = cancel.clone();
    let (event_sink, mut events) = sink();
    let call = tokio::spawn({
        let model = fixture_model(fixture.addr(), 3);
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
    wait_for_event(
        &deadline,
        &mut events,
        "model_retry_scheduled",
        is_retry_scheduled,
    )
    .await;
    cancel.cancel();
    let failure = expect_cancelled(
        deadline
            .run("cancelled retry call", call)
            .await
            .expect("cancelled retry task panicked"),
    );
    assert_eq!(failure.reason, "cancelled");
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("backoff cancellation", 1, 1);
}

#[tokio::test]
async fn cancellation_after_request_before_response_headers_prevents_another_attempt() {
    let mut fixture = Fixture::start(|_| Reply::Pending).await;
    let deadline = Bounded::new();
    let (event_sink, _events) = sink();
    let cancel = CancellationToken::new();
    let request_cancel = cancel.clone();
    let call = tokio::spawn({
        let model = fixture_model(fixture.addr(), 3);
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
    // 客户端请求已被 fixture 完整读取，但尚未收到任何响应头。
    fixture.seen(&deadline, 1).await;
    cancel.cancel();
    let failure = expect_cancelled(
        deadline
            .run("cancelled header wait", call)
            .await
            .expect("cancelled call task panicked"),
    );
    assert_eq!(failure.reason, "cancelled");
    fixture
        .finish(&deadline)
        .await
        .assert_attempts("header-wait cancellation", 1, 1);
}
