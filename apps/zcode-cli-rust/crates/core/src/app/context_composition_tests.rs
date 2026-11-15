//! 3.18 F4：`v4/conversation/contextComposition` 的查询契约（`upstream-3.18-rust-parity-r3.md`）。
//! 只用 Engine 已记录的会话事实：不加载冷会话、不重算、没有记录时返回 `null`。
use super::Engine;
use crate::{
    contract::{ContextPort, RuntimeClock, RuntimePorts, SessionStore, ToolPort},
    domain::session::Session,
};
use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

const SESSION: &str = "sess_ctx";
const WORKSPACE: &str = "/workspace";

struct Store;
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
    async fn session_exists(&self, _: &str) -> Result<bool> {
        bail!("the composition query must not probe storage")
    }
    async fn load_session(&self, _: &str, _: &str) -> Result<Option<Session>> {
        bail!("the composition query must not load a cold session")
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
}

struct NoTools;
#[async_trait]
impl ToolPort for NoTools {
    fn definitions(&self) -> Vec<Value> {
        vec![]
    }
    async fn execute(&self, _: &str, _: &Value, _: &CancellationToken) -> Result<String> {
        bail!("no tool may run for a query")
    }
    async fn cancel_session(&self, _: &str, _: Option<&str>) -> Result<()> {
        Ok(())
    }
}

struct NoContext;
#[async_trait]
impl ContextPort for NoContext {
    fn desktop(&self) -> bool {
        false
    }
    async fn snapshot(
        &self,
        _: &CancellationToken,
    ) -> Result<crate::domain::prompt::PromptSnapshot> {
        bail!("no snapshot for a query")
    }
    async fn instructions(
        &self,
        _: &CancellationToken,
    ) -> Result<crate::domain::prompt::InstructionRead> {
        bail!("no instructions for a query")
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

fn resident() -> Session {
    let mut session = Session::new(
        SESSION.into(),
        WORKSPACE.into(),
        "provider".into(),
        "model".into(),
        "normal".into(),
        "epoch".into(),
        123,
    );
    session.context_composition = Some(json!({
        "sessionId": SESSION,
        "revision": 2,
        "phase": "request",
        "measuredAt": 123,
        "model": {"providerId": "provider", "modelId": "model", "contextWindow": 200000},
        "tokenMethod": "estimated",
        "estimatedTokens": 10,
        "freeTokens": 199990,
        "categories": [{"id": "messages", "tokens": 10, "chars": 30}],
    }));
    session
}

async fn engine() -> Engine {
    Engine::new(
        WORKSPACE.into(),
        None,
        RuntimePorts {
            context: Arc::new(NoContext),
            store: Arc::new(Store),
            model: None,
            tools: Arc::new(NoTools),
            clock: Arc::new(FixedClock),
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn the_query_returns_the_last_recorded_request_without_touching_storage() {
    let mut engine = engine().await;
    assert_eq!(
        engine
            .context_composition_query(&json!({"sessionId": SESSION}))
            .unwrap(),
        json!({"composition": null})
    );
    engine.sessions.insert(SESSION.into(), resident());
    let result = engine
        .context_composition_query(&json!({"sessionId": SESSION}))
        .unwrap();
    assert_eq!(result["composition"]["revision"], 2);
    assert_eq!(result["composition"]["tokenMethod"], "estimated");
    // 完整模型选择是合法参数，但不改变结果（composition 描述真实发出的请求）。
    let with_selection = engine
        .context_composition_query(&json!({
            "sessionId": SESSION,
            "modelSelection": {"providerId": "provider", "modelId": "other",
                "options": {"reasoningLevel": "high"}}
        }))
        .unwrap();
    assert_eq!(with_selection, result);
    // 严格参数：无关字段与坏形状都拒绝，不静默忽略。
    for invalid in [
        json!({"sessionId": SESSION, "workspace": "/w"}),
        json!({"sessionId": ""}),
        json!({}),
        json!({"sessionId": SESSION, "modelSelection": {"providerId": "p"}}),
        json!({"sessionId": SESSION, "modelSelection": "provider:model"}),
    ] {
        assert!(
            engine.context_composition_query(&invalid).is_err(),
            "{invalid}"
        );
    }
}
