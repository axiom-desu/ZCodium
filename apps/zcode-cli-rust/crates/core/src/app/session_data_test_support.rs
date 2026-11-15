// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! `v4/storage/sessionData/*` 的运行时编排：响应形状、保留/失败语义、凭据顺序。
use super::Engine;
use crate::{
    contract::{ContextPort, RuntimeClock, RuntimePorts, SessionStore, ToolPort},
    domain::session::Session,
};
use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

pub(super) const WORKSPACE: &str = "/work";

#[derive(Default)]
pub(super) struct Store {
    pub(super) calls: Mutex<Vec<String>>,
    pub(super) trees: BTreeMap<String, Vec<String>>,
    pub(super) referrers: BTreeMap<String, Vec<String>>,
    pub(super) files: BTreeMap<String, Vec<Value>>,
    pub(super) sizes: BTreeMap<String, u64>,
    pub(super) snapshot: Value,
    pub(super) fail_files: BTreeSet<String>,
    pub(super) fail_begin: bool,
}

impl Store {
    pub(super) fn record(&self, call: impl Into<String>) {
        self.calls.lock().unwrap().push(call.into());
    }
    pub(super) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

pub(super) fn session(id: &str) -> Session {
    let mut session = Session::new(
        id.into(),
        "local".into(),
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
    async fn load_session(&self, _: &str, _id: &str) -> Result<Option<Session>> {
        Ok(None)
    }
    async fn read_session(&self, _: &str, _id: &str) -> Result<Option<Session>> {
        Ok(None)
    }
    async fn discard_draft(&self, _: &str, _: &str, _: Option<(String, Value)>) -> Result<()> {
        Ok(())
    }
    async fn commit(
        &self,
        _: &str,
        _: Option<&mut Session>,
        _: Option<(String, Value)>,
    ) -> Result<()> {
        Ok(())
    }
    async fn session_data_trees(&self, ids: &[String]) -> Result<Value> {
        self.record("trees");
        Ok(serde_json::to_value(
            ids.iter()
                .map(|id| (id.clone(), self.trees.get(id).cloned().unwrap_or_default()))
                .collect::<BTreeMap<_, _>>(),
        )?)
    }
    async fn session_data_referrers(&self, ids: &[String]) -> Result<Value> {
        Ok(serde_json::to_value(
            ids.iter()
                .filter(|id| self.referrers.contains_key(*id))
                .map(|id| (id.clone(), self.referrers[id].clone()))
                .collect::<BTreeMap<_, _>>(),
        )?)
    }
    async fn session_data_measure(&self, ids: &[String]) -> Result<Value> {
        Ok(serde_json::to_value(
            ids.iter()
                .map(|id| (id.clone(), json!(self.sizes.get(id).copied().unwrap_or(0))))
                .collect::<BTreeMap<_, _>>(),
        )?)
    }
    async fn session_data_memory(&self, directories: &[Value]) -> Result<Value> {
        Ok(directories
            .iter()
            .map(|directory| json!({"workspacePath": directory["workspacePath"], "bytes": 4}))
            .collect())
    }
    async fn session_data_remove(&self, id: &str, _retained: &[String]) -> Result<u64> {
        self.record(format!("remove:{id}"));
        if self.fail_files.contains(id) {
            bail!("injected file failure");
        }
        Ok(self.sizes.get(id).copied().unwrap_or(0))
    }
    async fn session_data_memory_remove(&self, _directory: &Value) -> Result<u64> {
        Ok(3)
    }
    async fn session_data_files(&self, id: &str) -> Result<Value> {
        Ok(json!(self.files.get(id).cloned().unwrap_or_default()))
    }
    async fn session_data_purge(&self, ids: &[String]) -> Result<()> {
        self.record(format!("purge:{}", ids.join(",")));
        Ok(())
    }
    async fn session_data_revision(&self, parts: &Value) -> Result<String> {
        Ok(format!("revision:{}", serde_json::to_string(parts)?))
    }
    async fn session_data_inspect(&self, _id: &str) -> Result<Value> {
        self.record("inspect");
        Ok(self.snapshot.clone())
    }
    async fn session_data_begin(
        &self,
        id: &str,
        revision: &str,
        operation: &str,
        retained: &[(String, String)],
    ) -> Result<()> {
        self.record(format!(
            "begin:{id}:{revision}:{operation}:{}",
            retained.len()
        ));
        if self.fail_begin {
            bail!("session-data.changed");
        }
        Ok(())
    }
    async fn session_data_complete(&self, id: &str) -> Result<()> {
        self.record(format!("complete:{id}"));
        Ok(())
    }
    async fn session_presence_register(&self, id: &str) -> Result<()> {
        self.record(format!("register:{id}"));
        Ok(())
    }
    async fn session_presence_unregister(&self, id: &str) -> Result<()> {
        self.record(format!("unregister:{id}"));
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

pub(super) fn snapshot() -> Value {
    json!({
        "workspacePath": WORKSPACE,
        "workspaceIdentity": null,
        "revision": "snapshot",
        "sessionIds": ["root", "child"],
        "forks": [{"sessionId": "fork", "title": "fork"}],
        "references": [{
            "sessionId": "root",
            "artifactId": "shared",
            "referrers": [{"sessionId": "fork", "title": "fork"}],
        }],
        "foreignRuntime": false,
        "localRuntimeIds": [],
        "pendingWork": false,
        "deleting": false,
        "completed": false,
    })
}

pub(super) fn files() -> BTreeMap<String, Vec<Value>> {
    BTreeMap::from([
        (
            "root".to_owned(),
            vec![
                json!({"name": "shared.png", "relativePath": "artifacts/root/shared.png", "kind": "artifact", "bytes": 6}),
                json!({"name": "private.txt", "relativePath": "artifacts/root/private.txt", "kind": "artifact", "bytes": 7}),
            ],
        ),
        (
            "child".to_owned(),
            vec![
                json!({"name": "log", "relativePath": "exec/child/log", "kind": "record", "bytes": 3}),
            ],
        ),
    ])
}

pub(super) async fn engine(store: Arc<Store>, resident: &[&str]) -> Engine {
    let mut engine = Engine::new(
        "local".into(),
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
    for id in resident {
        engine.sessions.insert((*id).into(), session(id));
    }
    engine
}
