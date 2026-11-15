//! 会话运行实例生命周期：只读预检、幂等激活/释放、代次与修订、失败隔离
//! （`.agents/specs/upstream-3.18-rust-parity.md` B 节）。
use super::Engine;
use crate::{
    contract::{
        ContextPort, Method, RuntimeClock, RuntimeError, RuntimePorts, SessionStore, ToolPort,
    },
    domain::session::Session,
};
use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

const SESSION: &str = "sess_1";
const WORKSPACE: &str = "/workspace";

/// 记录每次读/写，用来证明 getState/stop 不加载、不写库。
#[derive(Default)]
struct Store {
    calls: Mutex<Vec<&'static str>>,
    /// 会话在持久库里存在。
    persisted: AtomicBool,
    fail_load: bool,
    fail_release: AtomicBool,
}

impl Store {
    fn persisted() -> Self {
        Self {
            persisted: AtomicBool::new(true),
            ..Self::default()
        }
    }
    fn record(&self, call: &'static str) {
        self.calls.lock().unwrap().push(call);
    }
    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}

fn session(id: &str) -> Session {
    let mut session = Session::new(
        id.into(),
        WORKSPACE.into(),
        "provider".into(),
        "model".into(),
        "normal".into(),
        "epoch".into(),
        123,
    );
    session.workspace_path = Some(WORKSPACE.into());
    session
}

#[async_trait]
impl SessionStore for Store {
    async fn load_index(&self, _: &str) -> Result<BTreeMap<String, Value>> {
        Ok(BTreeMap::new())
    }
    async fn lookup_ack(&self, _: &str, _: &str) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn load(&self, _: &str) -> Result<(Vec<Session>, BTreeMap<String, Value>)> {
        Ok((vec![], BTreeMap::new()))
    }
    async fn session_exists(&self, id: &str) -> Result<bool> {
        self.record("exists");
        Ok(id == SESSION && self.persisted.load(Ordering::SeqCst))
    }
    async fn load_session(&self, _: &str, id: &str) -> Result<Option<Session>> {
        self.record("load");
        if self.fail_load {
            bail!("recovery failed");
        }
        Ok((id == SESSION && self.persisted.load(Ordering::SeqCst)).then(|| session(id)))
    }
    async fn read_session(&self, _: &str, id: &str) -> Result<Option<Session>> {
        self.record("read");
        Ok((id == SESSION && self.persisted.load(Ordering::SeqCst)).then(|| session(id)))
    }
    async fn discard_draft(&self, _: &str, _: &str, _: Option<(String, Value)>) -> Result<()> {
        self.record("discard");
        if self.fail_release.load(Ordering::SeqCst) {
            bail!("storage commit failed");
        }
        Ok(())
    }
    async fn commit(
        &self,
        _: &str,
        _: Option<&mut Session>,
        _: Option<(String, Value)>,
    ) -> Result<()> {
        self.record("commit");
        if self.fail_release.load(Ordering::SeqCst) {
            bail!("storage commit failed");
        }
        Ok(())
    }
}

struct NoTools;
#[async_trait]
impl ToolPort for NoTools {
    fn definitions(&self) -> Vec<Value> {
        vec![]
    }
    async fn execute(&self, _: &str, _: &Value, _: &CancellationToken) -> Result<String> {
        bail!("tool execution must be unused")
    }
    async fn cancel_session(&self, _: &str, _: Option<&str>) -> Result<()> {
        Ok(())
    }
}

struct FixedClock;
impl RuntimeClock for FixedClock {
    fn now(&self) -> u64 {
        123
    }
    fn id(&self) -> String {
        "fixed-epoch".into()
    }
}

struct UnusedContext;
#[async_trait]
impl ContextPort for UnusedContext {
    fn desktop(&self) -> bool {
        false
    }
    async fn snapshot(
        &self,
        _: &CancellationToken,
    ) -> Result<crate::domain::prompt::PromptSnapshot> {
        bail!("ContextPort must be unused")
    }
    async fn instructions(
        &self,
        _: &CancellationToken,
    ) -> Result<crate::domain::prompt::InstructionRead> {
        bail!("ContextPort must be unused")
    }
}

async fn engine(store: Arc<Store>, resident: bool) -> Engine {
    let mut engine = Engine::new(
        WORKSPACE.into(),
        None,
        RuntimePorts {
            context: Arc::new(UnusedContext),
            store,
            model: None,
            tools: Arc::new(NoTools),
            clock: Arc::new(FixedClock),
        },
    )
    .await
    .unwrap();
    if resident {
        engine.sessions.insert(SESSION.into(), session(SESSION));
    }
    engine
}

fn params(session: &str) -> Value {
    json!({"sessionId": session})
}

async fn call(engine: &mut Engine, method: Method, params: Value) -> Result<Value> {
    engine.session_lifecycle(method, &params).await
}

fn code(error: &anyhow::Error) -> String {
    match RuntimeError::classify(error) {
        RuntimeError::Fault {
            code: Some(code), ..
        } => code,
        RuntimeError::Coded { code: -32004, .. } => "notFound".into(),
        other => format!("{other:?}"),
    }
}

#[tokio::test]
async fn get_state_is_a_read_only_probe_of_a_cold_session() {
    let store = Arc::new(Store::persisted());
    let mut engine = engine(store.clone(), false).await;
    let snapshot = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        params(SESSION),
    )
    .await
    .unwrap();
    assert_eq!(
        snapshot,
        json!({"sessionId": SESSION, "state": "unloaded", "generation": 0, "revision": 0,
            "lastError": null})
    );
    // 只读预检：没有加载、没有提交、也没有隐式激活。
    assert_eq!(store.calls(), ["exists"]);
    assert!(engine.sessions.is_empty());
}

#[tokio::test]
async fn get_state_of_a_missing_session_fails_without_loading_anything() {
    let store = Arc::new(Store::persisted());
    let mut engine = engine(store.clone(), false).await;
    let error = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        params("nope"),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "notFound");
    assert_eq!(store.calls(), ["exists"]);
    assert!(engine.sessions.is_empty());
}

#[tokio::test]
async fn ensure_ready_activates_once_and_is_idempotent() {
    let store = Arc::new(Store::persisted());
    let mut engine = engine(store.clone(), false).await;
    assert_eq!(
        call(
            &mut engine,
            Method::SessionLifecycleEnsureReady,
            params(SESSION)
        )
        .await
        .unwrap(),
        json!({"completed": true})
    );
    assert!(engine.sessions.contains_key(SESSION));
    let first = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        params(SESSION),
    )
    .await
    .unwrap();
    assert_eq!(first["state"], "ready");
    assert_eq!(first["generation"], 1);
    // 第二次：已 ready 不重复加载，代次不变。
    let loads = store.calls().iter().filter(|c| **c == "load").count();
    call(
        &mut engine,
        Method::SessionLifecycleEnsureReady,
        params(SESSION),
    )
    .await
    .unwrap();
    assert_eq!(
        store.calls().iter().filter(|c| **c == "load").count(),
        loads,
        "an already ready instance is not re-activated"
    );
    let second = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        params(SESSION),
    )
    .await
    .unwrap();
    assert_eq!(second["generation"], 1);
}

#[tokio::test]
async fn ensure_ready_rejects_a_conflicting_workspace_before_activating() {
    let store = Arc::new(Store::persisted());
    let mut engine = engine(store.clone(), false).await;
    let error = call(
        &mut engine,
        Method::SessionLifecycleEnsureReady,
        json!({"sessionId": SESSION, "workspace": {
            "workspacePath": "/other", "workspaceKey": "other"}}),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "project.session-lineage-invalid");
    assert!(!store.calls().contains(&"load"), "预检失败不得激活");
    assert!(engine.sessions.is_empty());
}

#[path = "session_lifecycle_stop_tests.rs"]
mod stop;
