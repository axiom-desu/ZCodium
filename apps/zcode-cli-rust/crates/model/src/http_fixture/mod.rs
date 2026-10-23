//! 共享回环 HTTP fixture：M4 模型协议测试的唯一 mock 实现。
//!
//! 只处理 loopback、无凭据、无外网。fixture 完整读取请求头与
//! `Content-Length` 请求体，按请求序号返回脚本化响应，并记录每个请求的
//! 观测时刻，供退避/取消断言使用。
//!
//! 计数分两层：`accepted` 在 accept(2) 层递增，`complete` 在读完完整请求后
//! 递增。`finish()` 会 drain accept backlog，使取消后迟到的额外连接也计入
//! `accepted`，用例必须同时断言两者等于期望 attempt 数才不会 under-count。
mod io;
use super::config::ModelConfig;
use crate::contract::{Event, EventSink, ModelFailure, ModelOutput, RequestOrigin, RunEvent};
use crate::provider::HttpModel;
use io::{drain_accepts, read_request, write_chunked, write_full};
use std::future::Future;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use zcode_cli_net::{Egress, NetworkPolicy, RuntimeEnv};

/// 单个集成用例的统一有界 deadline；模型调用、事件等待、server join 共用。
pub struct Bounded(tokio::time::Instant);

impl Bounded {
    pub fn new() -> Self {
        Self(Instant::now() + Duration::from_secs(10))
    }

    /// 在 deadline 内等待；超时立即 panic，避免测试挂起。
    pub async fn run<F: Future>(&self, what: &str, future: F) -> F::Output {
        match tokio::time::timeout_at(self.0, future).await {
            Ok(value) => value,
            Err(_) => panic!("test deadline exceeded while waiting for {what}"),
        }
    }
}

/// fixture 对一次已完整读取的请求的响应。
pub enum Reply {
    /// 写完整响应后关闭连接。
    Close(Response),
    /// 写响应头与一个 chunk 后保持连接，直到 fixture 关闭。
    Hold(Response),
    /// 只计数、不回响应头，用于“已接收但未回 headers”的取消用例。
    Pending,
}

/// 一个完整的 HTTP 响应；`Content-Length` 与 `Connection: close` 自动补齐。
pub struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16) -> Self {
        Self {
            status,
            headers: vec![],
            body: vec![],
        }
    }

    pub fn sse(body: &str) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "text/event-stream".into())],
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

/// fixture 观测到的连接计数；字段公开，专门用例可区分 accepted 与 complete。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixtureStats {
    /// accept(2) 层成功接受的连接数（含 backlog 中尚未读完请求的连接）。
    pub accepted: usize,
    /// 已完整读取请求头与 `Content-Length` body 的连接数。
    pub complete: usize,
}

impl FixtureStats {
    /// 断言 accept 层与完整读取层都没有多余 attempt，并打印实际统计。
    pub fn assert_attempts(self, label: &str, accepted: usize, complete: usize) {
        assert_eq!(
            self.accepted, accepted,
            "{label}: unexpected accepted connections: {self:?}"
        );
        assert_eq!(
            self.complete, complete,
            "{label}: unexpected completed requests: {self:?}"
        );
    }
}

type Responder = Arc<dyn Fn(usize) -> Reply + Send + Sync>;

/// 一个 loopback 测试 server：持续 accept 并按脚本响应，直到 [`Fixture::finish`]。
pub struct Fixture {
    addr: SocketAddr,
    accepted: Arc<AtomicUsize>,
    complete: Arc<AtomicUsize>,
    arrivals: Arc<Mutex<Vec<Instant>>>,
    /// 每个完整请求的原始字节（头 + body），供 wire 断言。
    requests: Arc<Mutex<Vec<String>>>,
    observed: mpsc::UnboundedReceiver<usize>,
    observed_count: usize,
    shutdown: CancellationToken,
    server: Option<tokio::task::JoinHandle<()>>,
}

impl Fixture {
    pub async fn start<F>(responder: F) -> Self
    where
        F: Fn(usize) -> Reply + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback fixture");
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let complete = Arc::new(AtomicUsize::new(0));
        let arrivals = Arc::new(Mutex::new(Vec::new()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (observed_tx, observed) = mpsc::unbounded_channel();
        let shutdown = CancellationToken::new();
        let responder: Responder = Arc::new(responder);
        let server = tokio::spawn({
            let accepted = accepted.clone();
            let complete = complete.clone();
            let arrivals = arrivals.clone();
            let requests = requests.clone();
            let shutdown = shutdown.clone();
            async move {
                let mut tasks = JoinSet::new();
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        accepted_socket = listener.accept() => {
                            let Ok((socket, _)) = accepted_socket else { continue };
                            accepted.fetch_add(1, Ordering::SeqCst);
                            let complete = complete.clone();
                            let arrivals = arrivals.clone();
                            let requests = requests.clone();
                            let responder = responder.clone();
                            let observed = observed_tx.clone();
                            let shutdown = shutdown.clone();
                            tasks.spawn(async move {
                                handle(socket, complete, (arrivals, requests), responder, observed, shutdown).await;
                            });
                        }
                    }
                }
                // 循环退出后此处已无 accept future 借用 listener：先把 backlog
                // 里迟到的连接计入 accepted，再统一中止阻塞在 shutdown 上的 handler。
                drain_accepts(&listener, &accepted).await;
                tasks.shutdown().await;
            }
        });
        Self {
            addr,
            accepted,
            complete,
            arrivals,
            requests,
            observed,
            observed_count: 0,
            shutdown,
            server: Some(server),
        }
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// 每个请求被完整读取并计数时的时刻，下标为请求序号。
    pub fn arrivals(&self) -> Vec<Instant> {
        self.arrivals.lock().unwrap().clone()
    }

    /// 已完整读取的原始请求文本，下标与 [`Self::arrivals`] 一致。
    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    /// 等到至少 `count` 个请求被观测到；channel 提前关闭立即失败。
    pub async fn seen(&mut self, deadline: &Bounded, count: usize) {
        while self.observed_count < count {
            deadline
                .run("an observed fixture request", self.observed.recv())
                .await
                .unwrap_or_else(|| panic!("fixture closed before request {count}"));
            self.observed_count += 1;
        }
    }

    /// 停止 server、join，并返回 accept 层与完整读取层的最终计数。
    pub async fn finish(mut self, deadline: &Bounded) -> FixtureStats {
        self.shutdown.cancel();
        let server = self.server.take().expect("fixture server already joined");
        deadline
            .run("the fixture server join", server)
            .await
            .expect("fixture server panicked");
        FixtureStats {
            accepted: self.accepted.load(Ordering::SeqCst),
            complete: self.complete.load(Ordering::SeqCst),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // 用例 panic 或忘记 finish 时取消并 abort server；server 持有的 JoinSet
        // 随任务 drop 一起中止全部 handler，避免任务与连接泄漏。
        self.shutdown.cancel();
        if let Some(server) = self.server.take() {
            server.abort();
        }
    }
}

#[allow(clippy::type_complexity)]
async fn handle(
    mut socket: tokio::net::TcpStream,
    complete: Arc<AtomicUsize>,
    (arrivals, requests): (Arc<Mutex<Vec<Instant>>>, Arc<Mutex<Vec<String>>>),
    responder: Responder,
    observed: mpsc::UnboundedSender<usize>,
    shutdown: CancellationToken,
) {
    let Ok(Some(raw)) = read_request(&mut socket).await else {
        return;
    };
    let number = complete.fetch_add(1, Ordering::SeqCst);
    arrivals.lock().unwrap().push(Instant::now());
    requests
        .lock()
        .unwrap()
        .push(String::from_utf8_lossy(&raw).into_owned());
    let _ = observed.send(number);
    match responder(number) {
        Reply::Close(response) => {
            let _ = write_full(&mut socket, &response).await;
        }
        Reply::Hold(response) => {
            let _ = write_chunked(&mut socket, &response).await;
            shutdown.cancelled().await;
        }
        Reply::Pending => shutdown.cancelled().await,
    }
}

/// 用统一环境构造 `HttpModel`（附件等测试复用同一 Egress 初始化）。
pub fn http_model(config: ModelConfig) -> HttpModel {
    let env = RuntimeEnv::from_vars(vec![("ZCODE_APP_VERSION".into(), "2.0.0".into())]);
    let egress = Egress::new(
        Arc::new(env),
        &NetworkPolicy::default(),
        Path::new("/nonexistent"),
        "test",
    )
    .unwrap();
    HttpModel::new(config, Arc::new(egress))
}

/// 指向 loopback fixture 的模型，短重试配置。
pub fn model(addr: SocketAddr, api: &str, retries: u32) -> HttpModel {
    let config: ModelConfig = serde_json::from_value(serde_json::json!({
        "providerId":"fixture", "modelId":"fixture", "reasoningLevel":"none",
        "baseUrl":format!("http://{addr}"), "apiType":api,
        "retry":{"maxRetries":retries,"baseDelayMs":0,"jitter":false},
        "streamIdleTimeoutMs":5000
    }))
    .unwrap();
    http_model(config)
}

pub fn fixture_model(addr: SocketAddr, retries: u32) -> HttpModel {
    model(addr, "openai-chat-completions", retries)
}

/// 事件 channel 与 [`EventSink`] 的唯一构造。
pub fn sink() -> (EventSink, mpsc::Receiver<RunEvent>) {
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

/// 事件是否为一次已排定的重试。
pub fn is_retry_scheduled(event: &RunEvent) -> bool {
    matches!(
        &event.event,
        Event::ModelStatus(status) if status["type"] == "model_retry_scheduled"
    )
}

/// 断言取消结果；`ModelOutput` 无 `Debug`，不能直接用 `expect_err`。
pub fn expect_cancelled(result: std::result::Result<ModelOutput, ModelFailure>) -> ModelFailure {
    match result {
        Ok(_) => panic!("cancelled model call unexpectedly succeeded"),
        Err(failure) => failure,
    }
}

/// 等待满足条件的事件；channel 提前关闭立即失败，不把正常结束当成命中。
pub async fn wait_for_event<F>(
    deadline: &Bounded,
    events: &mut mpsc::Receiver<RunEvent>,
    what: &str,
    mut predicate: F,
) -> RunEvent
where
    F: FnMut(&RunEvent) -> bool,
{
    loop {
        let event = deadline
            .run(what, events.recv())
            .await
            .unwrap_or_else(|| panic!("event channel closed while waiting for {what}"));
        if predicate(&event) {
            return event;
        }
    }
}

/// 等待首个非推理文本事件。
pub async fn expect_text_event(
    deadline: &Bounded,
    events: &mut mpsc::Receiver<RunEvent>,
) -> String {
    let event = wait_for_event(deadline, events, "the first model text event", |event| {
        matches!(
            &event.event,
            Event::Text {
                reasoning: false,
                ..
            }
        )
    })
    .await;
    match event.event {
        Event::Text { text, .. } => text,
        _ => unreachable!("predicate guarantees a text event"),
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
