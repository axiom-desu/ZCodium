// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use zcode_cli_protocol::Request;
use zcode_cli_rust::{app::Engine, contract::*, domain::session::Session};

struct Commit {
    session: Option<Session>,
    queue: Vec<Value>,
    messages: Vec<Value>,
    phase: String,
    last_role: String,
    session_id: String,
    permission: Option<Value>,
    permit: oneshot::Sender<bool>,
}
struct Store {
    calls: AtomicUsize,
    tx: mpsc::UnboundedSender<Commit>,
}
#[async_trait]
impl SessionStore for Store {
    async fn load_index(&self, _: &str) -> Result<BTreeMap<String, Value>> {
        Ok(BTreeMap::new())
    }
    async fn lookup_ack(&self, _: &str, _: &str) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn local_attachment(
        &self,
        _: &str,
        _: usize,
        (original, _): (&str, &str),
        mime: &str,
    ) -> Result<(String, zcode_cli_domain::session::StoredAttachment)> {
        use zcode_cli_domain::node_journal::files::{TextRead, local_text};
        let read = TextRead {
            content: "text",
            truncated: false,
            size: 4,
            total_lines: 1,
        };
        let stored = zcode_cli_domain::session::StoredAttachment {
            path: "/fixture-snapshot".into(),
            source_path: Some("local.txt".into()),
            media_type: mime.into(),
            total_bytes: 4,
            node: Some(local_text((original, "/fixture/local.txt"), read)),
            ..Default::default()
        };
        Ok((original.into(), stored))
    }
    async fn load(&self, _: &str) -> Result<(Vec<Session>, BTreeMap<String, Value>)> {
        Ok((vec![], BTreeMap::new()))
    }
    async fn commit(
        &self,
        _: &str,
        session: Option<&mut Session>,
        _: Option<(String, Value)>,
    ) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (permit, done) = oneshot::channel();
        self.tx.send(Commit {
            session: session.as_deref().cloned(),
            queue: session
                .as_ref()
                .map(|s| s.queue.clone())
                .unwrap_or_default(),
            messages: session
                .as_ref()
                .map(|s| s.messages.clone())
                .unwrap_or_default(),
            session_id: session.as_ref().map(|s| s.id.clone()).unwrap_or_default(),
            permission: session.as_ref().and_then(|s| s.pending.first()).cloned(),
            phase: session
                .as_ref()
                .map(|s| {
                    serde_json::to_value(s.phase)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned()
                })
                .unwrap_or_default(),
            last_role: session
                .as_ref()
                .and_then(|s| s.messages.last())
                .and_then(|v| v["role"].as_str())
                .unwrap_or("")
                .into(),
            permit,
        })?;
        anyhow::ensure!(done.await?, "injected commit failure");
        Ok(())
    }
}
struct Clock(AtomicUsize);
impl RuntimeClock for Clock {
    fn id(&self) -> String {
        format!("id{}", self.0.fetch_add(1, Ordering::SeqCst))
    }
    fn now(&self) -> u64 {
        1000
    }
}
struct Model {
    calls: AtomicUsize,
    tools: Vec<Value>,
    requests: mpsc::UnboundedSender<Vec<Value>>,
}
#[async_trait]
impl ModelPort for Model {
    async fn complete(
        &self,
        messages: Vec<Value>,
        _: &[Value],
        sink: &EventSink,
        _: &CancellationToken,
    ) -> std::result::Result<ModelOutput, ModelFailure> {
        self.requests.send(messages.to_vec()).unwrap();
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        // 来自旧 generation 的文本和结束事件不能污染当前 turn。
        sink.tx
            .send(RunEvent {
                session_id: sink.session_id.clone(),
                run_id: "stale".into(),
                event: Event::Text {
                    response_id: "stale".into(),
                    text: "stale pollution".into(),
                    reasoning: false,
                },
            })
            .await
            .unwrap();
        sink.tx
            .send(RunEvent {
                session_id: sink.session_id.clone(),
                run_id: "stale".into(),
                event: Event::Finished {
                    error: Some("stale error".into()),
                    model_failure: None,
                    cancelled: false,
                },
            })
            .await
            .unwrap();
        sink.tx
            .send(RunEvent {
                session_id: sink.session_id.clone(),
                run_id: "stale".into(),
                event: Event::ToolCleanupFailed("stale cleanup failure".into()),
            })
            .await
            .unwrap();
        let (reply, _) = oneshot::channel();
        sink.tx
            .send(RunEvent {
                session_id: sink.session_id.clone(),
                run_id: "stale".into(),
                event: Event::Todos {
                    call_id: "stale".into(),
                    write: Some(
                        serde_json::from_value(
                            json!([{"content":"stale todo","status":"pending","priority":"low"}]),
                        )
                        .unwrap(),
                    ),
                    reply,
                },
            })
            .await
            .unwrap();
        let calls = if first { self.tools.clone() } else { vec![] };
        let mut message = json!({"role":"assistant","content":if first{""}else{"done"}});
        if first {
            message["tool_calls"] = json!(calls);
        }
        Ok(ModelOutput {
            output_limit: false,
            message,
            calls,
            usage: json!({}),
            raw_finish_reason: None,
        })
    }
}
struct ToolStart {
    n: usize,
    name: String,
    done: oneshot::Sender<()>,
}
struct Tools {
    cancellations: AtomicUsize,
    calls: AtomicUsize,
    gates: Option<mpsc::UnboundedSender<ToolStart>>,
}
#[async_trait]
impl ToolPort for Tools {
    async fn cancel_session(&self, _: &str, _: Option<&str>) -> Result<()> {
        self.cancellations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn definitions(&self) -> Vec<Value> {
        vec![]
    }
    fn capability(
        &self,
        _: &str,
        name: &str,
        _: &Value,
    ) -> zcode_cli_rust::domain::permission::ToolCapability {
        // GuardedWrite 声明 alwaysAsk：任何模式下都询问，用于验证审批提交顺序。
        zcode_cli_rust::domain::permission::ToolCapability {
            always_ask: Some(name == "GuardedWrite"),
            read_only: Some(name == "Read"),
            destructive: Some(false),
            needs_approval: Some(false),
            side_effect_scope: Some("none".into()),
            ..Default::default()
        }
    }
    fn concurrent_safe(&self, name: &str) -> bool {
        name == "Read"
    }
    async fn execute(
        &self,
        name: &str,
        args: &Value,
        cancel: &CancellationToken,
    ) -> Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let n = args["n"].as_u64().unwrap() as usize;
        if let Some(gates) = &self.gates {
            let (done, rx) = oneshot::channel();
            gates.send(ToolStart {
                n,
                name: name.into(),
                done,
            })?;
            if name == "SlowCancel" {
                // 模拟子进程收到取消后仍需完成退出清理，Finished 不能越过这段清理。
                cancel.cancelled().await;
                rx.await?;
                anyhow::bail!("Cancelled after cleanup");
            }
            tokio::select! { _=cancel.cancelled()=>anyhow::bail!("Cancelled"), result=rx=>result? }
        }
        if name == "CleanupFailure" {
            return Err(zcode_cli_core_api::ProcessCleanupFailure.into());
        }
        if n == 1 {
            anyhow::bail!("injected tool failure");
        }
        Ok(format!("result {n}"))
    }
}
fn call(n: usize, name: &str) -> Value {
    json!({"id":format!("call{n}"),"function":{"name":name,"arguments":json!({"n":n}).to_string()}})
}
struct Runtime {
    input: mpsc::Sender<Input>,
    output: mpsc::Receiver<Vec<Value>>,
    running: tokio::task::JoinHandle<Result<()>>,
    store: Arc<Store>,
    model: Arc<Model>,
    tools: Arc<Tools>,
    commits: mpsc::UnboundedReceiver<Commit>,
    requests: mpsc::UnboundedReceiver<Vec<Value>>,
}
async fn start(calls: Vec<Value>, gates: Option<mpsc::UnboundedSender<ToolStart>>) -> Runtime {
    start_with_input(calls, gates, json!({"text":"run"})).await
}
async fn start_with_input(
    calls: Vec<Value>,
    gates: Option<mpsc::UnboundedSender<ToolStart>>,
    first: Value,
) -> Runtime {
    start_timed(calls, gates, first, (60_000, 300_000)).await
}
async fn start_timed(
    calls: Vec<Value>,
    gates: Option<mpsc::UnboundedSender<ToolStart>>,
    first: Value,
    timing: (u64, u64),
) -> Runtime {
    let (tx, commits) = mpsc::unbounded_channel();
    let store = Arc::new(Store {
        calls: AtomicUsize::new(0),
        tx,
    });
    let (requests_tx, requests) = mpsc::unbounded_channel();
    let model = Arc::new(Model {
        calls: AtomicUsize::new(0),
        tools: calls,
        requests: requests_tx,
    });
    let tools = Arc::new(Tools {
        cancellations: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
        gates,
    });
    let ports = RuntimePorts {
        context: Arc::new(zcode_cli_host::context_source::WorkspaceContext::new(
            std::env::temp_dir(),
            std::env::temp_dir().join("fixture-empty-home"),
            false,
            std::env::vars().collect(),
        )),
        store: store.clone(),
        model: Some(model.clone()),
        tools: tools.clone(),
        clock: Arc::new(Clock(AtomicUsize::new(0))),
    };
    let engine = Engine::new(
        "workspace".into(),
        Some(ModelIdentity {
            provider_id: "p".into(),
            model_id: "m".into(),
            reasoning_level: "none".into(),
        }),
        ports,
    )
    .await
    .unwrap()
    .with_question_timing(timing.0, timing.1);
    let (input, rx) = mpsc::channel(32);
    let (out, output) = mpsc::channel(64);
    let running = tokio::spawn(zcode_cli_rust::serve_values(
        engine,
        rx,
        out,
        CancellationToken::new(),
    ));
    let request:Request=serde_json::from_value(json!({"id":1,"method":"v4/command","params":{"commandId":"first","clientId":"test","sessionId":null,"type":"createSession","issuedAt":1000,"payload":{"workspaceId":"workspace","config":{"mode":"yolo"},"firstInput":first}}})).unwrap();
    input.send(Input::Request(request)).await.unwrap();
    Runtime {
        input,
        output,
        running,
        store,
        model,
        tools,
        commits,
        requests,
    }
}
async fn receive<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

#[path = "runtime_consistency/admission.rs"]
mod admission;
#[path = "runtime_consistency/basic.rs"]
mod basic;
#[path = "runtime_consistency/busy.rs"]
mod busy;
use busy::*;
