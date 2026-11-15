use crate::{ModelFailure, ToolOutput};
use serde_json::Value;
use tokio::sync::oneshot;

pub struct RunEvent {
    pub session_id: String,
    pub run_id: String,
    pub event: Event,
}
pub enum Event {
    FilePrepared {
        change: zcode_cli_domain::file_checkpoint::FileCheckpoint,
        committed: oneshot::Sender<()>,
    },
    Subagent {
        name: String,
        args: Value,
        call_id: String,
        profile: Option<Box<zcode_cli_domain::subagent::Profile>>,
        selection: Option<crate::ModelIdentity>,
        reply: oneshot::Sender<std::result::Result<crate::ChildHandle, String>>,
    },
    GoalStep {
        reply: oneshot::Sender<Option<zcode_cli_domain::goal::Goal>>,
    },
    GoalVerdict {
        target_id: String,
        verdict: zcode_cli_domain::goal::Verdict,
        usage: Value,
        reply: oneshot::Sender<Option<(zcode_cli_domain::goal::Goal, Value)>>,
    },
    SkillsInitialized {
        catalog: zcode_cli_domain::skills::SkillCatalog,
        reply: oneshot::Sender<zcode_cli_domain::skills::SkillCatalog>,
    },
    Todos {
        call_id: String,
        write: Option<Vec<zcode_cli_domain::todo::TodoItem>>,
        reply: oneshot::Sender<ToolOutput>,
    },
    TodoReminder {
        reply: oneshot::Sender<Value>,
    },
    /// EnterPlanMode / ExitPlanMode switching plan (Node `source: "tool"`); the
    /// error text becomes the tool failure.
    PlanMode {
        call_id: String,
        enable: bool,
        reply: oneshot::Sender<std::result::Result<(), String>>,
    },
    /// A transient reminder (plan mode or hook context) placed before session
    /// message `anchor`; kept by the engine for later runs of this process.
    Reminder {
        anchor: usize,
        kind: zcode_cli_domain::session_runtime::ReminderKind,
        message: Value,
    },
    /// The session's frozen plugin reference catalog (spec rust-m10-plugins §3.9).
    PluginCatalog {
        reply: oneshot::Sender<std::sync::Arc<[Value]>>,
    },
    /// 3.18 F1：指令文件读取结果（会话开始与 compaction 后重读）；owner 只做进程内缓存。
    InstructionsLoaded {
        files: std::sync::Arc<[zcode_cli_domain::instruction_files::File]>,
        /// 存在但读不出来的路径：增量公告不算删除，重读时也不覆盖旧缓存。
        unreadable: std::sync::Arc<[String]>,
        /// 读取时的压缩边界（`context.offset`）；缓存据此失效。
        boundary: usize,
        committed: oneshot::Sender<()>,
    },
    /// 3.18 F2：本 run 的 `total_tokens` 预算（进程内，不落库）。
    TotalTokensBudget(zcode_cli_domain::total_tokens::Budget),
    /// 3.18 F3：主会话 system 字节快照的 session_entry 写入（覆盖写）。
    PromptSystem {
        data: Value,
        committed: oneshot::Sender<()>,
    },
    /// 3.18 F12：本 run 新用到的能力标签（owner 并集写入 session_entry，只增不减）。
    SessionFeatures {
        features: Vec<String>,
    },
    /// 3.18 F4：主轮次真实请求的细类别分解（owner 记 revision/measuredAt，不落库）。
    ContextComposition {
        categories: Value,
        model: Option<Value>,
        context_window: Option<u64>,
    },
    /// A model-only user message (a `<system-reminder>`) the owner appends to
    /// the canonical history and persists before `committed`.
    ModelOnlyNotice {
        /// The Node notice source (`persistSyntheticUserNoticeForSession`).
        source: &'static str,
        /// The reminder body the Node notice stores.
        body: String,
        message: Value,
        /// Extra structured metadata (ToolSearch 增量公告) of the notice.
        metadata: Option<Value>,
        committed: oneshot::Sender<()>,
    },
    /// First step of a root session's run: its configured (user and plugin)
    /// hooks and its project hooks with their admission view.
    WorkspaceHooks {
        reply: oneshot::Sender<SessionHooks>,
    },
    /// One hook lifecycle event (Node `hook_run_*` session events).
    Hook(zcode_cli_domain::hooks::runner::Lifecycle),
    /// PermissionRequest hooks answered the prompt for `call_id` first; the
    /// engine resolves it only if it is still pending.
    PermissionHook {
        call_id: String,
        answer: PermissionAnswer,
        updates: Vec<zcode_cli_domain::permission::Update>,
        /// `true` when the hooks' answer resolved the prompt.
        accepted: oneshot::Sender<bool>,
    },
    /// UserPromptSubmit hooks blocked the turn's input: the engine takes the
    /// input's messages out of the model history before the run ends.
    PromptBlocked {
        committed: oneshot::Sender<()>,
    },
    ToolCleanupFailed(String),
    PromptInitialized {
        snapshot: Box<zcode_cli_domain::prompt::PromptSnapshot>,
        skills: zcode_cli_domain::skills::SkillCatalog,
        committed: oneshot::Sender<zcode_cli_domain::skills::SkillCatalog>,
    },
    AuxiliaryDone {
        result: std::result::Result<Value, ModelFailure>,
    },
    /// A Host interaction of an adapter: a notification when `reply` is
    /// `None` (`plugins/operationProgress`, spec rust-m10-4-plugin-sources
    /// §9.1), else a request whose raw result goes to `reply` (official MCP
    /// identity headers, spec rust-m10-plugins §3.11).
    HostCall {
        method: &'static str,
        params: Value,
        reply: Option<oneshot::Sender<Value>>,
    },
    /// A detached workspace request's reply with a protocol error (plugin management).
    AuxiliaryReply {
        result: std::result::Result<Value, crate::RuntimeError>,
    },
    /// 3.18：Host 权威请求，其 `params` schema 是 strict（如 `automation/pause` 只允许
    /// `automationId`），所以 requestId 由 Engine 分配、只存在于 Engine 的 waiter 表，
    /// 不写入 `params`。`reply` 收到 Host 的原始 result；Host 的错误回执在传输层被
    /// 投影成 `Null`，因此调用方不能把缺失回执当成 `false`。
    HostRequest {
        method: &'static str,
        params: Value,
        reply: oneshot::Sender<Value>,
    },
    /// A usage query's reply (spec rust-m9-usage-logs §2.4); the error is a storage failure.
    UsageDone {
        result: std::result::Result<Value, String>,
    },
    RequestAuth {
        provider: String,
        selection: Value,
        access: Value,
        reply: oneshot::Sender<Value>,
    },
    /// The model window and, for a root-session step, the context breakdown of
    /// the step request about to be sent (spec rust-m9-usage-logs §4.1).
    RequestContext {
        window: usize,
        breakdown: Option<Vec<Value>>,
    },
    CompactStarted {
        id: String,
        manual: bool,
        /// Node `CompactTrigger`: `manual`, `auto` or `reactive`.
        trigger: &'static str,
        /// The manual compaction carries custom instructions.
        instructions: bool,
        /// The history estimate (without the request prefix).
        tokens: usize,
        /// The request prefix estimate (system prompt, context and skills
        /// reminders): Node's compaction token counts include it.
        prefix: usize,
        committed: oneshot::Sender<()>,
    },
    CompactDone {
        id: String,
        context: zcode_cli_domain::context::ContextState,
        /// The history estimate after compaction (without the request prefix).
        tokens: usize,
        /// The request prefix estimate, as in `CompactStarted`.
        prefix: usize,
        usage: Value,
        /// The summary text before it is wrapped into the summary message.
        body: String,
        /// Node `groupsPreserved`: the recent assistant rounds kept verbatim.
        groups: usize,
        /// Plan file and read file reminders appended after the preserved messages.
        reminders: Vec<Value>,
        committed: oneshot::Sender<()>,
    },
    /// The compaction `id` failed; the run may go on (automatic compaction).
    CompactFailed {
        id: String,
        committed: oneshot::Sender<()>,
    },
    Background {
        task: zcode_cli_domain::background::BackgroundTask,
        committed: Option<oneshot::Sender<()>>,
    },
    /// An agent step failed after visible output and is retried (spec
    /// rust-m7-stream-recovery §2); the reply is the next request's `streamRecovery`.
    StreamRecovery {
        retry: u32,
        /// Node `maxRetries`: 10 for broken streams, 2 for Start Plan busy.
        max: u32,
        reply: oneshot::Sender<Value>,
    },
    /// One Node `ModelNetworkStatusEvent` payload of the run's model request.
    ModelStatus(Value),
    /// The main response's first tool-call output (Node `model_streaming`
    /// `tool_input_delta` / `tool_call`); only local TTFT observes it.
    ToolStreaming,
    Text {
        response_id: String,
        text: String,
        reasoning: bool,
    },
    ModelDone {
        stable: bool,
        message: Option<Value>,
        usage: Value,
        committed: oneshot::Sender<()>,
    },
    ToolStart {
        call: Value,
    },
    /// The call passed hooks and permission and its handler starts now (Node
    /// `tool_call_started`); only the legacy stream shows it.
    ToolExecuting {
        id: String,
    },
    /// One group of a step's calls committed (Node `tool_batch_complete`).
    ToolBatch {
        ids: Vec<String>,
    },
    Permission {
        call: Value,
        request: PermissionRequest,
        reply: oneshot::Sender<PermissionAnswer>,
    },
    Question {
        call_id: String,
        input: Box<zcode_cli_domain::question::QuestionInput>,
        reply: oneshot::Sender<zcode_cli_domain::question::QuestionAnswer>,
    },
    ToolDone {
        id: String,
        result: String,
        /// The message content when it has blocks (see `ToolOutput::model_content`).
        model_content: Option<Value>,
        display: Option<Value>,
        failed: bool,
        /// Permission denied: the row is cancelled instead of failed (Node `permission_denied`).
        denied: bool,
        /// Node's workspace checkpoint candidate of a file-mutating result.
        checkpoint: Option<Box<Value>>,
        /// What the usage recorders read from the result.
        facts: ToolFacts,
        committed: oneshot::Sender<()>,
    },
    StepBoundary {
        committed: oneshot::Sender<Option<Guide>>,
    },
    Finished {
        error: Option<String>,
        model_failure: Option<ModelFailure>,
        cancelled: bool,
    },
}

#[path = "contract_events_parts.rs"]
mod contract_events_parts;
pub use contract_events_parts::{
    EventSink, Guide, ModelOutput, PermissionAnswer, PermissionRequest, RequestAuth, RequestKind,
    RequestOrigin, SessionHooks, ToolFacts, WorkspaceHooks,
};
