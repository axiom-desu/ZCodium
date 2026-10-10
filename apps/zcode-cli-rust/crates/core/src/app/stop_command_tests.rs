use super::{Engine, engine::Active};
use crate::{
    contract::{
        ContextPort, ModelIdentity, RequestOrigin, RuntimeClock, RuntimePorts, SessionStore,
        ToolPort,
    },
    domain::{session::Session, stream_recovery::StepProbe, usage::Attribution, usage::RunUsage},
};
use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use zcode_cli_protocol::Command;

const SESSION: &str = "session";
const WORKSPACE: &str = "/workspace";

#[derive(Default)]
struct FakeStore {
    commits: AtomicUsize,
    ack: std::sync::Mutex<Option<Value>>,
}

#[async_trait]
impl SessionStore for FakeStore {
    async fn load_index(&self, _: &str) -> Result<BTreeMap<String, Value>> {
        Ok(BTreeMap::new())
    }
    async fn lookup_ack(&self, _: &str, _: &str) -> Result<Option<Value>> {
        Ok(self.ack.lock().unwrap().clone())
    }
    async fn load(&self, _: &str) -> Result<(Vec<Session>, BTreeMap<String, Value>)> {
        Ok((vec![], BTreeMap::new()))
    }
    async fn commit(
        &self,
        _: &str,
        _: Option<&mut Session>,
        ack: Option<(String, Value)>,
    ) -> Result<()> {
        self.commits.fetch_add(1, Ordering::SeqCst);
        if let Some((_, value)) = ack {
            *self.ack.lock().unwrap() = Some(value);
        }
        Ok(())
    }
}

#[derive(Default)]
struct FakeTool {
    cancellations: AtomicUsize,
}
#[async_trait]
impl ToolPort for FakeTool {
    fn definitions(&self) -> Vec<Value> {
        vec![]
    }
    async fn execute(&self, _: &str, _: &Value, _: &CancellationToken) -> Result<String> {
        bail!("tool execution must be unused")
    }
    async fn cancel_session(&self, _: &str, _: Option<&str>) -> Result<()> {
        self.cancellations.fetch_add(1, Ordering::SeqCst);
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
        bail!("ContextPort must be unused in stop tests")
    }
    async fn instructions(
        &self,
        _: &CancellationToken,
    ) -> Result<Vec<crate::domain::prompt::InstructionSource>> {
        bail!("ContextPort must be unused in stop tests")
    }
}

async fn engine() -> (Engine, Arc<FakeStore>, Arc<FakeTool>) {
    let store = Arc::new(FakeStore::default());
    let tools = Arc::new(FakeTool::default());
    let mut engine = Engine::new(
        WORKSPACE.into(),
        None,
        RuntimePorts {
            context: Arc::new(UnusedContext),
            store: store.clone(),
            model: None,
            tools: tools.clone(),
            clock: Arc::new(FixedClock),
        },
    )
    .await
    .unwrap();
    let mut session = Session::new(
        SESSION.into(),
        WORKSPACE.into(),
        "provider".into(),
        "model".into(),
        "normal".into(),
        "epoch".into(),
        123,
    );
    session.phase = crate::domain::execution::Phase::CompletedSuccess;
    session.revision = 7;
    session.queue = vec![
        json!({"queueItemId":"queued","dispatch":{"state":"reserved"},"delivery":{"admitted":"startNow"}}),
    ];
    session.auto_drain = true;
    session.queued_now = Some("queued".into());
    session.api_retry = Some(crate::domain::model::RetryState {
        attempt: 1,
        max_attempts: 3,
        next_retry_at: 999,
        reason_code: "test_retry",
    });
    engine.sessions.insert(SESSION.into(), session);
    (engine, store, tools)
}

fn command(id: &str, expected: Option<&str>) -> Command {
    Command {
        command_id: id.into(),
        client_id: "test-client".into(),
        session_id: Some(SESSION.into()),
        ttft: None,
        base_revision: None,
        base_log_epoch: None,
        kind: "stop".into(),
        payload: expected.map_or_else(
            || json!({}),
            |target| json!({"expectedForegroundExecutionId":target}),
        ),
        issued_at: 123.0,
    }
}

fn active(run_id: &str, token: CancellationToken) -> Active {
    let (selection, _) = watch::channel(ModelIdentity {
        provider_id: "provider".into(),
        model_id: "model".into(),
        reasoning_level: "normal".into(),
    });
    let (permissions, _) = watch::channel(Arc::new(super::permissions::Snapshot {
        state: Default::default(),
        plan_exit_pending: false,
        policy: Default::default(),
        project_rules: Arc::default(),
        working_directory: WORKSPACE.into(),
        headless: false,
    }));
    Active {
        selection,
        cancel: token,
        run_id: run_id.into(),
        turn_id: "turn".into(),
        origin: Arc::new(RequestOrigin::default()),
        execution: None,
        permissions,
        kind: crate::domain::legacy_stream::RunKind::Prompt,
        legacy_lock: false,
        step: StepProbe::default(),
        usage: RunUsage::new(Attribution::default(), 123),
        request: None,
    }
}

fn snapshot(
    engine: &Engine,
) -> (
    u64,
    Vec<Value>,
    bool,
    Option<Value>,
    Option<String>,
    Option<crate::domain::model::RetryState>,
) {
    let s = &engine.sessions[SESSION];
    (
        s.revision,
        s.queue.clone(),
        s.auto_drain,
        s.goal
            .as_ref()
            .map(|goal| serde_json::to_value(goal).unwrap()),
        s.queued_now.clone(),
        s.api_retry.clone(),
    )
}

#[tokio::test]
async fn idle_and_mismatched_expected_stops_are_real_dispatch_noops() {
    for active_run in [None, Some("run-new")] {
        let (mut engine, store, tools) = engine().await;
        if let Some(run_id) = active_run {
            engine
                .active
                .insert(SESSION.into(), active(run_id, CancellationToken::new()));
        }
        let token_cancelled = engine
            .active
            .get(SESSION)
            .is_some_and(|run| run.cancel.is_cancelled());
        let before = snapshot(&engine);
        let commits = store.commits.load(Ordering::SeqCst);
        let cancellations = tools.cancellations.load(Ordering::SeqCst);
        let result = engine
            .dispatch_command(command("guarded", Some("run-old")))
            .await
            .unwrap();
        assert_eq!(result["status"], "noop");
        assert_eq!(result["reasonCode"], "guard.stopTargetChanged");
        assert_eq!(snapshot(&engine), before);
        assert_eq!(store.commits.load(Ordering::SeqCst), commits);
        assert_eq!(tools.cancellations.load(Ordering::SeqCst), cancellations);
        assert_eq!(
            engine
                .active
                .get(SESSION)
                .is_some_and(|run| run.cancel.is_cancelled()),
            token_cancelled
        );
    }
}

#[tokio::test]
async fn matching_active_stop_cancels_and_replays_exact_receipt_after_run_disappears() {
    let (mut engine, store, tools) = engine().await;
    let token = CancellationToken::new();
    engine
        .active
        .insert(SESSION.into(), active("run-1", token.clone()));
    let before = snapshot(&engine);
    let command = command("exact-command", Some("run-1"));
    let accepted = engine.dispatch_command(command.clone()).await.unwrap();
    assert_eq!(accepted["status"], "accepted");
    assert!(token.is_cancelled());
    assert_eq!(tools.cancellations.load(Ordering::SeqCst), 1);
    assert_eq!(store.commits.load(Ordering::SeqCst), 1);
    let after = snapshot(&engine);
    assert_eq!(after.0, before.0 + 1);
    assert!(!after.2);
    assert_eq!(after.4, None);
    assert_eq!(after.1[0]["dispatch"]["state"], "queued");
    assert_eq!(engine.acks.get(&command.key()), Some(&accepted));
    engine.active.remove(SESSION);
    let duplicate = engine.dispatch_command(command).await.unwrap();
    assert_eq!(duplicate["status"], "duplicate");
    assert_eq!(
        duplicate["revisionAtDecision"],
        accepted["revisionAtDecision"]
    );
    assert_eq!(tools.cancellations.load(Ordering::SeqCst), 1);
    assert_eq!(store.commits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stop_without_expected_target_keeps_legacy_unconditional_behavior() {
    let (mut engine, store, tools) = engine().await;
    let token = CancellationToken::new();
    engine
        .active
        .insert(SESSION.into(), active("run-legacy", token.clone()));
    let result = engine
        .dispatch_command(command("legacy", None))
        .await
        .unwrap();
    assert_eq!(result["status"], "accepted");
    assert!(token.is_cancelled());
    assert_eq!(tools.cancellations.load(Ordering::SeqCst), 1);
    assert_eq!(store.commits.load(Ordering::SeqCst), 1);
    assert!(!engine.sessions[SESSION].auto_drain);
}
