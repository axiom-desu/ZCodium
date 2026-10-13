use super::*;
use crate::contract::{EventSink, ModelPort, RequestOrigin};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use zcode_cli_net::{NetworkPolicy, RuntimeEnv};

const CHAT_OK: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

fn fixture_model(addr: std::net::SocketAddr, retries: u32) -> HttpModel {
    let config = serde_json::from_value(json!({
        "providerId":"fixture", "modelId":"fixture", "reasoningLevel":"none",
        "baseUrl":format!("http://{addr}"), "apiType":"openai-chat-completions",
        "retry":{"maxRetries":retries,"baseDelayMs":0,"jitter":false},
        "streamIdleTimeoutMs":5000
    }))
    .unwrap();
    let egress = Egress::new(
        Arc::new(RuntimeEnv::from_vars(vec![])),
        &NetworkPolicy::default(),
        std::path::Path::new("/nonexistent"),
        "test",
    )
    .unwrap();
    HttpModel::new(config, Arc::new(egress))
}

fn sink() -> (EventSink, mpsc::Receiver<crate::contract::RunEvent>) {
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
}

async fn accept_request(socket: &mut tokio::net::TcpStream) {
    let mut bytes = [0; 4096];
    let _ = socket.read(&mut bytes).await.unwrap();
}

async fn write_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    retry_after: Option<&str>,
) {
    let body = if status == 200 { CHAT_OK } else { "" };
    let retry = retry_after
        .map(|v| format!("Retry-After: {v}\r\n"))
        .unwrap_or_default();
    let header = format!(
        "HTTP/1.1 {status} Fixture\r\n{retry}Content-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(header.as_bytes()).await.unwrap();
    socket.write_all(body.as_bytes()).await.unwrap();
}

#[tokio::test]
async fn non_retryable_http_is_not_retried_and_retry_budget_caps_attempts() {
    for (status, retries, expected) in [(400, 5, 1), (503, 2, 3)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(AtomicUsize::new(0));
        let server_seen = seen.clone();
        let (call_finished, mut finish_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            for _ in 0..expected {
                let (mut socket, _) = listener.accept().await.unwrap();
                accept_request(&mut socket).await;
                server_seen.fetch_add(1, Ordering::SeqCst);
                write_response(&mut socket, status, None).await;
            }
            loop {
                tokio::select! {
                    _ = &mut finish_rx => break,
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        accept_request(&mut socket).await;
                        server_seen.fetch_add(1, Ordering::SeqCst);
                        write_response(&mut socket, status, None).await;
                    }
                }
            }
            let listener = listener.into_std().unwrap();
            listener.set_nonblocking(true).unwrap();
            while listener.accept().is_ok() {
                server_seen.fetch_add(1, Ordering::SeqCst);
            }
        });
        let (event_sink, _events) = sink();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fixture_model(addr, retries).complete(
                vec![json!({"role":"user","content":"hi"})],
                &[],
                &event_sink,
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("model call did not finish");
        assert!(result.is_err(), "HTTP {status} unexpectedly succeeded");
        call_finished.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .expect("fixture server did not shut down")
            .unwrap();
        assert_eq!(seen.load(Ordering::SeqCst), expected, "HTTP {status}");
    }
}

#[tokio::test]
async fn positive_retry_after_is_honored_before_next_attempt() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        accept_request(&mut first).await;
        write_response(&mut first, 503, Some("1")).await;
        let started = tokio::time::Instant::now();
        let (mut second, _) = listener.accept().await.unwrap();
        accept_request(&mut second).await;
        write_response(&mut second, 200, None).await;
        started.elapsed()
    });
    let (event_sink, _events) = sink();
    let cancel = CancellationToken::new();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture_model(addr, 1).complete(
            vec![json!({"role":"user","content":"hi"})],
            &[],
            &event_sink,
            &cancel,
        ),
    )
    .await
    .expect("retry-after call did not finish")
    .unwrap();
    assert_eq!(result.message["content"], "ok");
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .expect("fixture server did not finish")
            .unwrap()
            >= std::time::Duration::from_millis(900)
    );
}

#[tokio::test]
async fn cancellation_during_retry_backoff_prevents_another_attempt() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(AtomicUsize::new(0));
    let server_seen = seen.clone();
    let (call_finished, mut finish_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        accept_request(&mut socket).await;
        server_seen.fetch_add(1, Ordering::SeqCst);
        write_response(&mut socket, 503, Some("5")).await;
        loop {
            tokio::select! {
                _ = &mut finish_rx => break,
                accepted = listener.accept() => {
                    let (mut socket, _) = accepted.unwrap();
                    accept_request(&mut socket).await;
                    server_seen.fetch_add(1, Ordering::SeqCst);
                    write_response(&mut socket, 503, Some("5")).await;
                }
            }
        }
        let listener = listener.into_std().unwrap();
        listener.set_nonblocking(true).unwrap();
        while listener.accept().is_ok() {
            server_seen.fetch_add(1, Ordering::SeqCst);
        }
    });
    let cancel = CancellationToken::new();
    let request_cancel = cancel.clone();
    let (event_sink, mut events) = sink();
    let call = tokio::spawn(async move {
        fixture_model(addr, 3)
            .complete(
                vec![json!({"role":"user","content":"hi"})],
                &[],
                &event_sink,
                &request_cancel,
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let crate::contract::Event::ModelStatus(status) = event.event
                && status["type"] == "model_retry_scheduled"
            {
                break;
            }
        }
    })
    .await
    .expect("retry scheduling event was not received");
    cancel.cancel();
    let failure = match tokio::time::timeout(std::time::Duration::from_secs(5), call)
        .await
        .expect("cancelled retry did not finish")
        .unwrap()
    {
        Ok(_) => panic!("cancelled retry unexpectedly succeeded"),
        Err(failure) => failure,
    };
    assert_eq!(failure.reason, "cancelled");
    call_finished.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .expect("fixture server did not shut down")
        .unwrap();
    assert_eq!(seen.load(Ordering::SeqCst), 1);
}
