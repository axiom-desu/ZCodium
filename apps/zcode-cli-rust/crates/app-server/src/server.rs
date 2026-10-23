// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! App Server event loop: JSON-RPC routing, delivery and host bridging.
//!
//! Ordering rules:
//! - The loop never awaits the runtime. Requests are queued and sent when the
//!   runtime can accept them, while runtime output is always drained, so the
//!   two bounded channels cannot deadlock.
//! - A runtime reply is written before the events that follow it in the same
//!   runtime batch, matching the Node runtime (response line, then frames).
use super::{Sink, delivery::Delivery};
use crate::contract::{ClientMsg, Input, Method, RuntimeError, ServerMsg};
use anyhow::Result;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;
use zcode_cli_protocol::{Request, RequestId};

/// Queued runtime requests above which stdin is not read (backpressure to the reader thread).
const MAX_QUEUED_REQUESTS: usize = 64;
const RUNTIME_CHANNEL: usize = 64;
/// Node `ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS`.
const PREFERENCES_TIMEOUT: Duration = Duration::from_secs(15);
const PREFERENCES_METHOD: &str = "session/requestRuntimePreferences";

/// App Server 启动选项。默认保持纯路由：进程内嵌入/测试没有可回答偏好请求的 Host。
#[derive(Clone, Copy, Debug, Default)]
pub struct ServeOptions {
    /// Desktop Host 在 `session/create` / `session/resume` 前经既有反向 RPC 读取 App 设置。
    pub request_session_preferences: bool,
}

struct PreferenceWait {
    request: Request,
    deadline: Instant,
}

pub(super) enum Pending {
    Rpc(Option<RequestId>),
    Subscribe {
        id: Option<RequestId>,
        topic: String,
        connection: String,
        profile: crate::domain::delivery::Profile,
    },
    Resync {
        id: Option<RequestId>,
        subscription: String,
    },
    Recover {
        subscription: String,
    },
}

pub(super) struct Server {
    pub(super) sink: Sink,
    pub(super) delivery: Delivery,
    pub(super) to_runtime: VecDeque<ClientMsg>,
    pub(super) calls: HashMap<u64, Pending>,
    pub(super) next_token: u64,
    pub(super) input_open: bool,
    pub(super) congested: bool,
    options: ServeOptions,
    preferences: HashMap<String, PreferenceWait>,
    next_preference: u64,
}

/// Run the App Server over `runtime` with the default routing options.
pub async fn serve<F, Fut>(runtime: F, input: mpsc::Receiver<Input>, sink: Sink) -> Result<()>
where
    F: FnOnce(mpsc::Receiver<ClientMsg>, mpsc::Sender<Vec<ServerMsg>>) -> Fut,
    Fut: std::future::Future<Output = Result<()>> + Send + 'static,
{
    serve_with_options(runtime, input, sink, ServeOptions::default()).await
}

/// Run the App Server over `runtime`, reading parsed wire input and writing to `sink`.
/// Returns the runtime's result after it stops and its output is drained.
pub async fn serve_with_options<F, Fut>(
    runtime: F,
    mut input: mpsc::Receiver<Input>,
    sink: Sink,
    options: ServeOptions,
) -> Result<()>
where
    F: FnOnce(mpsc::Receiver<ClientMsg>, mpsc::Sender<Vec<ServerMsg>>) -> Fut,
    Fut: std::future::Future<Output = Result<()>> + Send + 'static,
{
    let (client_tx, client_rx) = mpsc::channel(RUNTIME_CHANNEL);
    let (server_tx, mut server_rx) = mpsc::channel(RUNTIME_CHANNEL);
    let running = tokio::spawn(runtime(client_rx, server_tx));
    let mut server = Server {
        sink,
        delivery: Delivery::default(),
        to_runtime: VecDeque::new(),
        calls: HashMap::new(),
        next_token: 0,
        input_open: true,
        congested: false,
        options,
        preferences: HashMap::new(),
        next_preference: 0,
    };
    let mut drain = tokio::time::interval(Duration::from_millis(100));
    drain.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        // 订阅者缓冲的刷新窗口（spec rust-m8-delivery §5）；拥塞期间由 drain 恢复。
        let due = server.delivery.next_due().filter(|_| !server.congested);
        let flush_at = due.map_or_else(Instant::now, Instant::from_std);
        let preference_due = server.preference_deadline();
        let preference_at =
            preference_due.unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            biased;
            batch = server_rx.recv() => match batch {
                Some(batch) => server.on_runtime(batch).await?,
                None => {
                    server.flush_final().await?;
                    break;
                }
            },
            _ = tokio::time::sleep_until(flush_at), if due.is_some() => server.flush().await?,
            permit = client_tx.reserve(), if !server.to_runtime.is_empty() => match permit {
                Ok(permit) => permit.send(server.to_runtime.pop_front().expect("queue is not empty")),
                // runtime 已停止接收；剩余请求没有 owner，等待其输出关闭后退出。
                Err(_) => server.to_runtime.clear(),
            },
            message = input.recv(), if server.input_open && server.to_runtime.len() < MAX_QUEUED_REQUESTS => match message {
                Some(message) => server.on_input(message).await?,
                None => server.end_input(),
            },
            _ = drain.tick(), if server.congested => server.relieve().await?,
            _ = tokio::time::sleep_until(preference_at), if preference_due.is_some() => server.expire_preferences().await?,
        }
    }
    running.await?
}

pub(super) fn response(id: RequestId, result: Result<Value, RuntimeError>) -> String {
    match result {
        Ok(value) => json!({"id":id,"result":value}),
        Err(error) => json!({"id":id,"error":error.to_json()}),
    }
    .to_string()
}

pub(super) fn required<'a>(p: &'a Value, key: &str) -> Result<&'a str, RuntimeError> {
    p[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RuntimeError::InvalidParams(format!("{key}: required")))
}

pub(super) fn not_owned() -> RuntimeError {
    RuntimeError::Fault {
        message: "fault.subscription.notOwned".into(),
        code: None,
    }
}

impl Server {
    pub(super) fn forward(&mut self, method: Method, params: Value, pending: Pending) {
        self.next_token += 1;
        self.calls.insert(self.next_token, pending);
        self.to_runtime.push_back(ClientMsg::Request {
            token: self.next_token,
            method,
            params,
        });
    }

    fn end_input(&mut self) {
        if self.input_open {
            self.input_open = false;
            self.to_runtime.push_back(ClientMsg::Eof);
        }
    }

    async fn reply(
        &mut self,
        id: Option<RequestId>,
        result: Result<Value, RuntimeError>,
    ) -> Result<()> {
        match id {
            Some(id) => self.sink.send(vec![response(id, result)]).await,
            None => Ok(()),
        }
    }

    async fn on_input(&mut self, message: Input) -> Result<()> {
        let invalid = || Some(RequestId::Text("invalid-message".into()));
        match message {
            Input::Request(request) => self.on_request(request).await,
            Input::Response { id, result } => {
                if let Some(wait) = self.preferences.remove(&id) {
                    return self.resume_request(wait.request, result).await;
                }
                self.to_runtime
                    .push_back(ClientMsg::HostReply { id, result });
                Ok(())
            }
            Input::Invalid => {
                let error = RuntimeError::Coded {
                    code: -32700,
                    message: "Invalid protocol request".into(),
                };
                self.reply(invalid(), Err(error)).await
            }
            Input::TooLarge => {
                let error = RuntimeError::Coded {
                    code: -32600,
                    message: "Request exceeds size limit".into(),
                };
                self.end_input();
                self.reply(invalid(), Err(error)).await
            }
            Input::Eof => {
                self.end_input();
                Ok(())
            }
        }
    }

    /// Desktop Host 的 App 设置在既有 runtime 创建/冷恢复边界读取一次，不逐轮读取。
    fn wants_preferences(&self, request: &Request) -> bool {
        self.options.request_session_preferences
            && matches!(request.method.as_str(), "session/create" | "session/resume")
            && request.params.get("runtimeConfig").is_none()
    }

    async fn request_preferences(&mut self, request: Request) -> Result<()> {
        self.next_preference += 1;
        let id = format!("rust-prefs-{}", self.next_preference);
        // Node 在 createRecord 前生成 sessionId；这里只用于偏好请求，不写回严格 params。
        let session_id = request.params["sessionId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("sess_{}", zcode_cli_host::id()));
        self.preferences.insert(
            id.clone(),
            PreferenceWait {
                request,
                deadline: Instant::now() + PREFERENCES_TIMEOUT,
            },
        );
        self.sink
            .send_values(vec![json!({
                "id": id,
                "method": PREFERENCES_METHOD,
                "params": {"sessionId": session_id, "scope": "runtime-materialization"},
            })])
            .await
    }

    /// 把 Host 返回的模式写入既有 `runtimeConfig.toolSearch.mode`；旧 Host 缺字段时回退 Off。
    async fn resume_request(&mut self, mut request: Request, result: Value) -> Result<()> {
        if let Some(mode) = result["toolSearchMode"]
            .as_str()
            .filter(|mode| matches!(*mode, "auto" | "native" | "local" | "off"))
        {
            request.params["runtimeConfig"] = json!({"toolSearch": {"mode": mode}});
        }
        self.route_request(request).await
    }

    fn preference_deadline(&self) -> Option<Instant> {
        self.preferences.values().map(|wait| wait.deadline).min()
    }

    /// Host 不响应时不永久阻塞创建；超时按旧 Host 语义继续（Off）。
    async fn expire_preferences(&mut self) -> Result<()> {
        let now = Instant::now();
        let expired: Vec<String> = self
            .preferences
            .iter()
            .filter(|(_, wait)| wait.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(wait) = self.preferences.remove(&id) {
                self.route_request(wait.request).await?;
            }
        }
        Ok(())
    }

    async fn on_request(&mut self, request: Request) -> Result<()> {
        if self.wants_preferences(&request) {
            return self.request_preferences(request).await;
        }
        self.route_request(request).await
    }

    async fn route_request(&mut self, request: Request) -> Result<()> {
        let Request {
            id, method, params, ..
        } = request;
        let routed = match method.as_str() {
            "v4/conversation/subscribe" => self.subscribe(id.clone(), &params),
            "v4/conversation/resync" => self.resync(id.clone(), &params),
            "v4/conversation/unsubscribe" => self.unsubscribe(&params).map(Some),
            "v4/connection/flow" => self.flow(&params).map(Some),
            name => match Method::parse(name) {
                Some(method) => {
                    self.forward(method, params, Pending::Rpc(id.clone()));
                    Ok(None)
                }
                None => Err(RuntimeError::MethodNotFound(name.into())),
            },
        };
        match routed {
            Ok(None) => Ok(()),
            Ok(Some(value)) => self.reply(id, Ok(value)).await,
            Err(error) => self.reply(id, Err(error)).await,
        }
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
