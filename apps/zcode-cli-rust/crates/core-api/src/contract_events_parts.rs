//! 事件之外的核心契约结构（hook 视图、工具事实、权限请求/回答、事件通道）。
//! 拆分自 `contract_events.rs`，定义逐字搬移，只为把源文件保持在 400 行上限内。
use super::{Event, RunEvent};
use anyhow::Result;
use serde_json::Value;
use tokio::sync::mpsc;

/// The hooks of a session's runs beyond the startup user hooks.
pub struct SessionHooks {
    /// User and enabled plugin hooks (Node configured hooks); `None`: no
    /// plugin hooks, the startup user hooks stay.
    pub configured: Option<std::sync::Arc<[zcode_cli_domain::hooks::Registration]>>,
    /// `None`: no project hooks, or trust is unavailable.
    pub project: Option<WorkspaceHooks>,
}
/// A session's project hooks as admitted for its runs.
pub struct WorkspaceHooks {
    pub registrations: Vec<zcode_cli_domain::hooks::Registration>,
    pub view:
        tokio::sync::watch::Receiver<std::sync::Arc<zcode_cli_domain::hooks::trust::AdmissionView>>,
}
/// The usage facts of a tool result (Node `recordToolUsageFromResult` and
/// `appendNestedToolModelUsage`).
#[derive(Clone, Debug, Default)]
pub struct ToolFacts {
    /// Bash's exit code (Node `perf.detail.command.exitCode`).
    pub exit_code: Option<i64>,
    pub truncated: bool,
    /// Node `output.modelUsage`: a tool's internal model request (WebSearch).
    pub model_usage: Option<Value>,
    /// Node `ToolCallResult.result.perf` without the permission wait: the
    /// call's `totalMs` and the tool's detail.
    pub perf: Option<Value>,
    /// `(error type, code)` of a failure with its own error class (`ToolOutput.error`).
    pub error: Option<(&'static str, &'static str)>,
}

pub struct ModelOutput {
    pub message: Value,
    pub calls: Vec<Value>,
    pub usage: Value,
    pub output_limit: bool,
    /// The provider's own finish reason (AI SDK `rawFinishReason`): Anthropic
    /// `stop_reason`, Chat `finish_reason`, Responses `incomplete_details.reason`.
    pub raw_finish_reason: Option<String>,
}
/// A tool call the policy asked the user about.
pub struct PermissionRequest {
    /// Decision reason, shown as the prompt summary.
    pub reason: String,
    /// Policy risk level (`low` / `medium` / `high` / `critical`).
    pub risk_level: String,
    /// Arguments as the policy saw them.
    pub input: Value,
    pub suggestions: Vec<zcode_cli_domain::permission::Update>,
    /// Tool `askOptions.allowAlways`: `no-always-allow` / `session-always-allow`.
    pub options_policy: Option<String>,
}
/// The resolved prompt (Node broker result).
#[derive(Debug, PartialEq)]
pub enum PermissionAnswer {
    Allow,
    /// `preserve`: user feedback is kept verbatim instead of summarized.
    Deny {
        message: String,
        preserve: bool,
    },
    /// Allowed, but the tool fails before running (Node: project rule write failed).
    Fail(String),
    /// ExitPlanMode not approved; `Some` carries the user's feedback.
    PlanRejected(Option<String>),
}
/// Messages committed at a step boundary (guided input or subagent mailbox).
pub struct Guide {
    pub messages: Vec<Value>,
    /// The run's new request origin when a guided user input changed it.
    pub origin: Option<std::sync::Arc<RequestOrigin>>,
    /// Tools the guided input hides from the rest of the turn (merged into the run).
    pub tool_disallowlist: Vec<String>,
}
/// `modelExecution.requestAuth` (`{apiKey?, headers?}`) frozen for one execution.
/// It replaces the Host credential request and is never persisted or logged.
pub struct RequestAuth(pub Value);
impl std::fmt::Debug for RequestAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestAuth(<redacted>)")
    }
}
/// Model request source, sent as `x-zcode-session-type`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RequestKind {
    Main,
    Subagent,
    #[default]
    Other,
}
impl RequestKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Subagent => "subagent",
            Self::Other => "other",
        }
    }
}
/// Attribution of model requests (Node `ModelStatusContext`). Owned by the
/// engine; a run only holds a copy that the engine replaces on guided input.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RequestOrigin {
    pub kind: RequestKind,
    pub session_id: Option<String>,
    pub trace_id: String,
    pub query_id: Option<String>,
    /// Node `querySource` (`main_turn`, `subagent`, `compact`); empty when none.
    pub query_source: &'static str,
    /// Node `streamRecovery` of a request that recovers a broken stream: added
    /// to its network statuses and raising its idle timeout.
    pub stream_recovery: Option<std::sync::Arc<Value>>,
}
impl RequestOrigin {
    /// A request outside any session run, with a trace of its own.
    pub fn detached(trace_id: String) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            trace_id,
            ..Self::default()
        })
    }
    /// The same run context for work that is not an agent step (compaction).
    pub fn auxiliary(&self) -> std::sync::Arc<Self> {
        self.other("compact")
    }
    /// A run's internal request outside the agent step (Node `other` session
    /// type), e.g. `web_fetch_processing`.
    pub fn other(&self, query_source: &'static str) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            kind: RequestKind::Other,
            query_source,
            ..self.clone()
        })
    }
}
#[derive(Clone)]
pub struct EventSink {
    pub session_id: String,
    pub run_id: String,
    pub tx: mpsc::Sender<RunEvent>,
    pub origin: std::sync::Arc<RequestOrigin>,
    /// Credentials frozen for this execution; `None` asks the Host when required.
    pub request_auth: Option<std::sync::Arc<RequestAuth>>,
}
impl EventSink {
    pub async fn send(&self, event: Event) -> Result<()> {
        self.tx
            .send(RunEvent {
                session_id: self.session_id.clone(),
                run_id: self.run_id.clone(),
                event,
            })
            .await?;
        Ok(())
    }
}
