// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::{Event, RunEvent};
use crate::{
    contract::{
        ClientMsg, Method, ModelIdentity, ModelPort, RuntimeClock, RuntimePorts, ServerMsg,
        SessionStore, StorageCommitFailure, ToolPort,
    },
    domain::session::Session,
};
use anyhow::Result;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
/// Actor output: one ordered channel carrying replies, events and host requests.
pub type RuntimeOutput = mpsc::Sender<Vec<ServerMsg>>;
/// A request as the actor sees it; `token` echoes back in the reply.
pub(super) struct Call {
    pub token: u64,
    pub method: Method,
    pub params: Value,
}
pub(super) struct Active {
    pub selection: tokio::sync::watch::Sender<ModelIdentity>,
    pub cancel: CancellationToken,
    pub run_id: String,
    pub turn_id: String,
    /// Attribution of this run's model requests; the loop holds a copy.
    pub origin: std::sync::Arc<crate::contract::RequestOrigin>,
    /// Execution-scoped model and credentials (`sendText.modelExecution`).
    pub execution: Option<std::sync::Arc<super::submission::Execution>>,
    /// Permission inputs for this run's tool calls; the engine publishes updates.
    pub permissions: tokio::sync::watch::Sender<std::sync::Arc<super::permissions::Snapshot>>,
    /// What started the run (spec 9.12).
    pub kind: crate::domain::legacy_stream::RunKind,
    /// Node `record.activeAbortController`: legacy send / compact / goal refuse
    /// to start while it is held (spec 9.12).
    pub legacy_lock: bool,
    /// The agent step request as the recovery sees it (spec rust-m7-stream-recovery §2).
    pub step: crate::domain::stream_recovery::StepProbe,
    /// Usage facts in progress (spec rust-m9-usage-logs §2.3).
    pub usage: crate::domain::usage::RunUsage,
    /// The step request in flight: its model window and context breakdown
    /// (spec rust-m9-usage-logs §4.1).
    pub request: Option<super::usage_state::StepRequest>,
}
pub struct Engine {
    /// The live telemetry normalizer (spec rust-m9-usage-logs §5).
    pub(super) telemetry: crate::domain::telemetry::Normalizer,
    /// Local TTFT records and their clock (spec rust-m9-usage-logs §7).
    pub(super) ttft: crate::domain::local_ttft::Recorder,
    pub(super) ttft_clock: super::local_ttft::TtftClock,
    pub(super) child_updates:
        BTreeMap<String, tokio::sync::watch::Sender<crate::domain::subagent::Task>>,
    pub(super) uploads: crate::domain::attachment_upload::Uploads,
    pub(super) auxiliary: BTreeMap<String, super::auxiliary::Auxiliary>,
    pub(super) registry: Option<Arc<dyn crate::contract::ModelRegistry>>,
    pub(super) workspace_path: String,
    pub(super) workspace: String,
    pub(super) config: Option<ModelIdentity>,
    pub(super) store: Arc<dyn SessionStore>,
    pub(super) model: Option<Arc<dyn ModelPort>>,
    pub(super) context: Arc<dyn crate::contract::ContextPort>,
    pub(super) tools: Arc<dyn ToolPort>,
    pub(super) clock: Arc<dyn RuntimeClock>,
    pub(super) sessions: BTreeMap<String, Session>,
    pub(super) index: BTreeMap<String, Value>,
    pub(super) closed: std::collections::BTreeSet<String>,
    /// 会话运行实例生命周期（代次/修订/最后失败）；residency 事实仍在 `sessions`。
    pub(super) lifecycle: super::session_lifecycle::Records,
    pub(super) session_access: BTreeMap<String, u64>,
    pub(super) access_seq: u64,
    pub(super) durable_acks: std::collections::BTreeSet<String>,
    pub(super) acks: BTreeMap<String, Value>,
    pub(super) active: BTreeMap<String, Active>,
    /// Mode fallbacks, project and session rules, config lists.
    pub(super) permissions: super::permissions::Permissions,
    /// Input options handed from admission to run start, keyed by (session, turn).
    pub(super) submissions: BTreeMap<(String, String), super::submission::Submission>,
    /// Everything waiting on an external answer; released per owner on every terminal path.
    pub(super) waiters: super::waiters::Waiters,
    /// Open delivery topics and their subscriber count; a conversation topic pins its session.
    pub(super) interest: BTreeMap<String, usize>,
    pub(super) epoch: String,
    pub(super) index_seq: u64,
    pub(super) index_log: crate::domain::topic_log::TopicLog,
    pub(super) config_seq: u64,
    pub(super) outbox: Vec<ServerMsg>,
    pub(super) auto_resolution_preference: bool,
    pub(super) question_timing: (u64, u64),
    /// `-p`: no permission client, every ask is denied (spec rust-m4-headless 3.2).
    pub(super) headless: bool,
    pub(super) events: mpsc::Sender<RunEvent>,
    pub(super) event_rx: mpsc::Receiver<RunEvent>,
    pub(super) hooks: super::workspace_trust::HookState,
    pub(super) anomaly_guard: crate::domain::model_anomaly::Guard,
    pub(super) titles: bool,
    pub(super) tool_search_mode: crate::domain::tool_search::Mode,
    pub(super) tool_search_override: Option<crate::domain::tool_search::Mode>,
}
impl Engine {
    pub async fn new(
        workspace: String,
        config: Option<ModelIdentity>,
        ports: RuntimePorts,
    ) -> Result<Self> {
        let RuntimePorts {
            context,
            store,
            model,
            tools,
            clock,
        } = ports;
        // 仅未完成的文件事务需要冷读对应 session；普通启动仍然只读取 metadata 索引。
        for id in tools.pending_rewinds().await? {
            let session = store.load_session(&workspace, &id).await?;
            if let Some(session) = session {
                tools
                    .recover_rewind(&id, session.rewind_committed.as_deref())
                    .await?;
            }
        }
        let index = store.load_index(&workspace).await?;
        let permissions = super::permissions::Permissions::from_settings(
            &store.project_settings(&workspace).await?,
        );
        let (events, event_rx) = mpsc::channel(128);
        tools.attach_events(events.clone(), &workspace);
        Ok(Self {
            telemetry: Default::default(),
            ttft: crate::domain::local_ttft::Recorder::new(clock.id()),
            ttft_clock: Default::default(),
            child_updates: BTreeMap::new(),
            uploads: Default::default(),
            auxiliary: BTreeMap::new(),
            registry: None,
            workspace_path: workspace.clone(),
            workspace,
            config,
            store,
            model,
            tools,
            clock: clock.clone(),
            context,
            sessions: BTreeMap::new(),
            index,
            closed: Default::default(),
            lifecycle: Default::default(),
            session_access: Default::default(),
            access_seq: 0,
            durable_acks: Default::default(),
            acks: BTreeMap::new(),
            active: BTreeMap::new(),
            submissions: BTreeMap::new(),
            permissions,
            waiters: Default::default(),
            interest: BTreeMap::new(),
            epoch: clock.id(),
            index_seq: 0,
            index_log: crate::domain::topic_log::TopicLog::index(),
            config_seq: 0,
            outbox: vec![],
            auto_resolution_preference: true,
            headless: false,
            question_timing: (60_000, 300_000),
            events,
            event_rx,
            hooks: Default::default(),
            anomaly_guard: Default::default(),
            titles: false,
            tool_search_mode: crate::domain::tool_search::Mode::Off,
            tool_search_override: None,
        })
    }
    pub async fn serve(
        mut self,
        mut input: mpsc::Receiver<ClientMsg>,
        output: RuntimeOutput,
        cancel: CancellationToken,
    ) -> Result<()> {
        let mut refresh = tokio::time::interval(std::time::Duration::from_secs(1));
        refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // 工具层的进程遥测（MCP 进程启动、崩溃、资源采样）经 Engine 输出（spec rust-m9-usage-logs §6）。
        let mut process_events = self.tools.process_events();
        let serving = async {
            loop {
                let question_delay = self.question_delay();
                tokio::select! {
                    _=async {if let Some(delay)=question_delay {tokio::time::sleep(delay).await} else {std::future::pending::<()>().await}}=>{self.advance_questions().await?;self.flush(&output).await?;},
                    _=cancel.cancelled()=>break,
                    message=input.recv()=>match message {
                        Some(ClientMsg::Request{token,method,params})=>self.request(Call{token,method,params},&output).await?,
                        Some(ClientMsg::HostReply{id,result})=> { if let Some(wait) = self.waiters.take_host(&id) { let _ = wait.reply.send(result); } },
                        Some(ClientMsg::TopicReleased{topic})=>{self.release_topic(&topic);self.trim_resident().await?;},
                        Some(ClientMsg::ConnectionClosed{connection})=>{self.uploads.clear_connection(&connection);self.trim_resident().await?;},
                        Some(ClientMsg::Eof) | None=>break,
                    },
                    Some(event)=self.event_rx.recv()=>{
                        let terminal=matches!(&event.event,Event::Finished {..}) || matches!(&event.event,Event::Background {task,..} if task.status!="running");
                        self.apply_event(event).await?;self.flush(&output).await?;
                        if terminal {self.trim_resident().await?;}
                    },
                    Some((method, params))=async {match process_events.as_mut() {Some(rx)=>rx.recv().await, None=>std::future::pending().await}}=>{
                        self.outbox.push(ServerMsg::HostNotification{method,params});self.flush(&output).await?;
                    },
                    _=refresh.tick()=>{
                        self.uploads.prune(self.clock.now());if self.ttft.active() {self.ttft_tick();self.flush(&output).await?;}
                        if let Some(registry) = &self.registry && registry.refresh(None).await.unwrap_or(false) { self.refresh_catalog()?; self.flush(&output).await?; }
                    },
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        let mut result =
            tokio::select! {biased; _=cancel.cancelled()=>Ok(()), result=serving=>result};
        let mut storage_failed = result
            .as_ref()
            .err()
            .is_some_and(|e| e.is::<StorageCommitFailure>());
        if result.is_err() {
            self.child_updates.clear();
        }
        for active in self.active.values() {
            active.cancel.cancel();
        }
        for job in self.auxiliary.values() {
            job.cancel.cancel();
        }
        self.auxiliary.clear();
        for session in self.sessions.values_mut() {
            if let Some(goal) = &mut session.goal {
                goal.finish_run(self.clock.now(), false, Some("paused"));
            }
            session.auto_drain = false;
            session.queued_now = None;
        }
        self.waiters.clear();
        for id in self.sessions.keys() {
            self.tools.cancel_session(id, None).await?;
        }
        // 必须等待拥有的工具 task 收口后再释放 runtime；只 drop Tokio task 会漏掉 Shell 后代。
        // 清理期限由工具 adapter 的 TERM/KILL 生命周期拥有；不能在 1200ms
        // 提前 drop 仍处于 1500ms 宽限期的前台任务，留下工作进程或丢失终态。
        while !self.active.is_empty()
            || (!storage_failed
                && self
                    .sessions
                    .values()
                    .any(|s| s.background.values().any(|t| t.status == "running")))
        {
            match self.event_rx.recv().await {
                Some(event) => {
                    // 事务失败后的内存事实不可再提交；否则一次失败的 ACK/工具结果会被收口路径复活。
                    if storage_failed {
                        if matches!(event.event, Event::Finished { .. })
                            && self
                                .active
                                .get(&event.session_id)
                                .is_some_and(|active| active.run_id == event.run_id)
                        {
                            self.active.remove(&event.session_id);
                        }
                    } else if let Err(error) = self.apply_event(event).await {
                        storage_failed = true;
                        self.child_updates.clear();
                        result = Err(error);
                    }
                    self.outbox.clear();
                }
                _ => break,
            }
        }
        self.event_rx.close();
        self.tools.shutdown().await?;
        // EOF 后持久化中断态，再结束 actor；不等待挂起权限或再次启动队列。
        for session in self.sessions.values_mut() {
            if (session.running() || session.background.values().any(|t| t.status == "running"))
                && !storage_failed
            {
                session.recover(self.clock.id(), self.clock.now());
                self.store
                    .commit_receipt(&self.workspace, Some(session), None)
                    .await?;
            }
        }
        result
    }
}

#[path = "engine_request.rs"]
mod engine_request;
