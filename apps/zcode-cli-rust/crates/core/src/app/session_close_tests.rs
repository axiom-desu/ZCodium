//! `deleteSession` execution order: the durable soft-deletion fact lands before
//! any runtime release, and a failed write publishes no removal.
use super::Engine;
use crate::{
    contract::{ContextPort, RuntimeClock, RuntimePorts, SessionStore, ToolPort},
    domain::session::Session,
};
use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
use zcode_cli_protocol::Command;

const SESSION: &str = "session";
const WORKSPACE: &str = "/workspace";

#[derive(Default)]
struct OrderedStore {
    calls: Mutex<Vec<&'static str>>,
    fail_soft_delete: bool,
}

impl OrderedStore {
    fn record(&self, call: &'static str) {
        self.calls.lock().unwrap().push(call);
    }
    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl SessionStore for OrderedStore {
    async fn load_index(&self, _: &str) -> Result<BTreeMap<String, Value>> {
        Ok(BTreeMap::new())
    }
    async fn lookup_ack(&self, _: &str, _: &str) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn load(&self, _: &str) -> Result<(Vec<Session>, BTreeMap<String, Value>)> {
        Ok((vec![], BTreeMap::new()))
    }
    async fn soft_delete_session(&self, _: &str, _: &str, _: u64) -> Result<()> {
        self.record("softDelete");
        if self.fail_soft_delete {
            bail!("storage unavailable");
        }
        Ok(())
    }
    async fn discard_draft(&self, _: &str, _: &str, _: Option<(String, Value)>) -> Result<()> {
        self.record("persist");
        Ok(())
    }
    async fn commit(
        &self,
        _: &str,
        _: Option<&mut Session>,
        _: Option<(String, Value)>,
    ) -> Result<()> {
        self.record("persist");
        Ok(())
    }
}

#[derive(Default)]
struct OrderedTool {
    calls: Arc<Mutex<Vec<&'static str>>>,
}

#[async_trait]
impl ToolPort for OrderedTool {
    fn definitions(&self) -> Vec<Value> {
        vec![]
    }
    async fn execute(&self, _: &str, _: &Value, _: &CancellationToken) -> Result<String> {
        bail!("tool execution must be unused")
    }
    async fn cancel_session(&self, _: &str, _: Option<&str>) -> Result<()> {
        self.calls.lock().unwrap().push("release");
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
    ) -> Result<Vec<crate::domain::prompt::InstructionSource>> {
        bail!("ContextPort must be unused")
    }
}

async fn engine(store: Arc<OrderedStore>, tool_calls: Arc<Mutex<Vec<&'static str>>>) -> Engine {
    let mut engine = Engine::new(
        WORKSPACE.into(),
        None,
        RuntimePorts {
            context: Arc::new(UnusedContext),
            store,
            model: None,
            tools: Arc::new(OrderedTool { calls: tool_calls }),
            clock: Arc::new(FixedClock),
        },
    )
    .await
    .unwrap();
    engine.sessions.insert(
        SESSION.into(),
        Session::new(
            SESSION.into(),
            WORKSPACE.into(),
            "provider".into(),
            "model".into(),
            "normal".into(),
            "epoch".into(),
            123,
        ),
    );
    engine
}

fn command(id: &str) -> Command {
    Command {
        command_id: id.into(),
        client_id: "test".into(),
        session_id: Some(SESSION.into()),
        ttft: None,
        base_revision: None,
        base_log_epoch: None,
        kind: "deleteSession".into(),
        payload: json!({}),
        issued_at: 123.0,
    }
}

#[tokio::test]
async fn deletion_persists_before_releasing_the_runtime() {
    let store = Arc::new(OrderedStore::default());
    let tool_calls = Arc::new(Mutex::new(vec![]));
    let mut engine = engine(store.clone(), tool_calls.clone()).await;
    let ack = engine.close_session(&command("c1")).await.unwrap();
    assert_eq!(ack["status"], "accepted");
    // 持久删除事实必须早于 runtime 释放与收口；否则重启后会话复活。
    assert_eq!(store.calls(), ["softDelete", "persist"]);
    // 取消前台/后台会话任务后关闭工具会话（默认 close_session 复用 cancel_session）。
    assert_eq!(*tool_calls.lock().unwrap(), ["release", "release"]);
    assert!(!engine.sessions.contains_key(SESSION));
}

#[tokio::test]
async fn a_failed_soft_delete_releases_nothing_and_publishes_no_removal() {
    let store = Arc::new(OrderedStore {
        fail_soft_delete: true,
        ..Default::default()
    });
    let tool_calls = Arc::new(Mutex::new(vec![]));
    let mut engine = engine(store.clone(), tool_calls.clone()).await;
    let error = engine.close_session(&command("c1")).await.unwrap_err();
    assert!(error.to_string().contains("storage unavailable"));
    assert_eq!(store.calls(), ["softDelete"]);
    assert!(tool_calls.lock().unwrap().is_empty());
    assert!(engine.sessions.contains_key(SESSION));
    // 没有移除事实：index 仍保留该会话的摘要位（从未入索引时为 None）。
    assert!(!engine.closed.contains(SESSION));
    assert!(!engine.index.contains_key(SESSION));
    assert_eq!(engine.index_seq, 0, "no index frame was published");
}

#[tokio::test]
async fn a_non_empty_payload_is_rejected_before_any_write() {
    let store = Arc::new(OrderedStore::default());
    let tool_calls = Arc::new(Mutex::new(vec![]));
    let mut engine = engine(store.clone(), tool_calls.clone()).await;
    let mut payload = command("c1");
    payload.payload = json!({"force": true});
    assert!(engine.close_session(&payload).await.is_err());
    assert!(store.calls().is_empty());
}

#[tokio::test]
async fn a_stale_delete_ack_writes_nothing_and_keeps_the_runtime() {
    let store = Arc::new(OrderedStore::default());
    let tool_calls = Arc::new(Mutex::new(vec![]));
    let mut engine = engine(store.clone(), tool_calls.clone()).await;
    let mut stale = command("c1");
    stale.base_revision = Some(99.0);
    let ack = engine.dispatch_command(stale).await.unwrap();
    assert_eq!(ack["status"], "stale");
    // 既有 stale 守卫先于删除分支：旧 revision 的删除不能落持久删除事实。
    assert!(store.calls().is_empty());
    assert!(engine.sessions.contains_key(SESSION));
    assert!(tool_calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn deletion_discards_accepted_queue_through_the_existing_close_path() {
    let store = Arc::new(OrderedStore::default());
    let tool_calls = Arc::new(Mutex::new(vec![]));
    let mut engine = engine(store.clone(), tool_calls.clone()).await;
    let queued = command("q1");
    let key = queued.key();
    engine.acks.insert(
        key.clone(),
        json!({"commandId":"q1","status":"accepted","revisionAtDecision":0,
            "result":{"delivery":{"mode":"queue"}}}),
    );
    engine.sessions.get_mut(SESSION).unwrap().queue = vec![json!({
        "sourceCommandId":"q1","queueItemId":"item-1","delivery":{"mode":"queue"}
    })];
    let ack = engine.close_session(&command("c1")).await.unwrap();
    assert_eq!(ack["status"], "accepted");
    // accepted queue 仍由既有 close 收口结算：不执行、不另建队列，标记 discardedOnClose。
    let discarded = &engine.acks[&key];
    assert_eq!(discarded["status"], "failed");
    assert_eq!(discarded["reasonCode"], "fault.input.discardedOnClose");
    assert_eq!(discarded["result"]["type"], "inputDisposition");
    assert!(
        tool_calls
            .lock()
            .unwrap()
            .iter()
            .all(|call| *call == "release")
    );
    assert!(!engine.sessions.contains_key(SESSION));
}
