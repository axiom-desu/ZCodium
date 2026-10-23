// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! Public runtime ports. The application owns state; adapters own external IO.
use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
pub use zcode_cli_domain::model::{
    ModelFailure, ModelRequestOptions, RetryState, ToolSearchCapability,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelIdentity {
    pub provider_id: String,
    pub model_id: String,
    pub reasoning_level: String,
}
pub type Output = mpsc::Sender<Vec<Value>>;
pub struct ChildHandle {
    pub task: zcode_cli_domain::subagent::Task,
    pub updates: tokio::sync::watch::Receiver<zcode_cli_domain::subagent::Task>,
    pub message_id: Option<String>,
    pub delivery: Option<String>,
}
#[derive(Debug)]
pub struct StorageCommitFailure;
impl std::fmt::Display for StorageCommitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("fault.storage.commit")
    }
}
impl std::error::Error for StorageCommitFailure {}
#[derive(Debug)]
pub struct ProcessCleanupFailure;
impl std::fmt::Display for ProcessCleanupFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("fault.runtime.processCleanup")
    }
}
impl std::error::Error for ProcessCleanupFailure {}

/// Receipt returned after the storage transaction is durable. The core uses
/// this boundary before advancing the model/tool loop or publishing facts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableCommitReceipt {
    pub receipt_id: String,
    pub workspace: String,
    pub session_id: Option<String>,
    pub sequence: u64,
}

pub enum Input {
    Request(zcode_cli_protocol::Request),
    Response { id: String, result: Value },
    Invalid,
    TooLarge,
    Eof,
}

pub use crate::contract_events::{
    Event, EventSink, Guide, ModelOutput, PermissionAnswer, PermissionRequest, RequestAuth,
    RequestKind, RequestOrigin, RunEvent, SessionHooks, ToolFacts, WorkspaceHooks,
};
pub use crate::contract_store::SessionStore;
pub use crate::contract_tool_error::{ToolError, render_failure};
pub use crate::contract_tools::{
    HookProcess, ToolOutput, ToolPermission, ToolPort, TrustLoad, TrustStorePort,
};
#[async_trait]
pub trait ModelPort: Send + Sync {
    fn identity(&self) -> Option<ModelIdentity> {
        None
    }
    fn format_properties(&self) -> Value {
        serde_json::json!({"inputFormat":{"supportsText":true,"supportsImage":false,"supportsVideo":false,"supportsAudio":false,"supportsPdf":false},"outputFormat":{"supportsText":true},"supportsToolCall":true})
    }
    /// Model property `supportsToolCall`（Node `model.properties.supportsToolCall`）。
    /// 注册配置缺字段的旧端口按支持处理，与既有内置默认一致。
    fn supports_tool_call(&self) -> bool {
        self.format_properties()["supportsToolCall"]
            .as_bool()
            .unwrap_or(true)
    }
    fn with_max_output_tokens(&self, _max: usize) -> Result<Option<Arc<dyn ModelPort>>> {
        Ok(None)
    }
    fn bind(&self) -> Option<Arc<dyn ModelPort>> {
        None
    }
    /// Node `auxiliaryModelOptions` with `maxOutputTokens ≤ 4096`: the lowest
    /// reasoning level of the current model; `None` keeps this model.
    fn auxiliary(&self) -> Option<Arc<dyn ModelPort>> {
        None
    }
    /// Model property `supportsNativeWebSearch` (WebSearch is offered).
    fn supports_native_web_search(&self) -> bool {
        false
    }
    /// Requests first refresh Host runtime headers (account providers; Node
    /// `shouldRefreshBeforeModelRequest`).
    fn account_auth(&self) -> bool {
        false
    }
    fn context_policy(&self) -> zcode_cli_domain::context::ContextPolicy {
        Default::default()
    }
    /// Node `Model.requestCapabilities.toolSearch`；`None` 表示端口未上报能力。
    fn tool_search_capability(&self) -> Option<ToolSearchCapability> {
        None
    }
    async fn complete(
        &self,
        messages: Vec<Value>,
        tools: &[Value],
        sink: &EventSink,
        cancel: &CancellationToken,
    ) -> std::result::Result<ModelOutput, ModelFailure>;
    /// 向后兼容的可选请求：默认 `false` 与 [`ModelPort::complete`] 完全等价；
    /// 请求 native ToolSearch 而端口未实现时在发送前拒绝，不退化成普通请求。
    async fn complete_with_options(
        &self,
        messages: Vec<Value>,
        tools: &[Value],
        options: &ModelRequestOptions,
        sink: &EventSink,
        cancel: &CancellationToken,
    ) -> std::result::Result<ModelOutput, ModelFailure> {
        if !options.tool_search_enabled {
            return self.complete(messages, tools, sink, cancel).await;
        }
        Err(ModelFailure::new("tool_search_unsupported", false))
    }
}
/// Runtime configuration is resolved outside the actor; credentials are never session facts.
#[async_trait]
pub trait ModelRegistry: Send + Sync {
    async fn received_account(&self) -> Option<Value> {
        None
    }
    fn catalog(&self) -> Vec<Value>;
    fn model_options(&self) -> Vec<Value> {
        self.catalog()
    }
    /// Visible models as Node `toModelOption` (legacy session snapshots).
    fn legacy_models(&self) -> Vec<Value> {
        vec![]
    }
    fn default_selection(&self) -> Option<ModelIdentity>;
    fn resolve(&self, selection: &ModelIdentity) -> Result<Arc<dyn ModelPort>>;
    async fn refresh(&self, account: Option<Value>) -> Result<bool>;
}
#[async_trait]
pub trait RewindTransaction: Send {
    fn preview(&self) -> Value;
    fn checkpoint_ids(&self) -> Vec<String>;
    async fn finish(self: Box<Self>, commit: bool) -> Result<()>;
}
pub trait RuntimeClock: Send + Sync {
    fn now(&self) -> u64;
    fn id(&self) -> String;
}
pub use RuntimeClock as Clock;

/// Request-scoped authentication. Implementations must never persist the
/// returned value in a session, queue, ACK or diagnostic record.
#[async_trait]
pub trait AuthPort: Send + Sync {
    async fn credentials(
        &self,
        session_id: &str,
        request_id: &str,
        workspace: &str,
    ) -> Result<Value>;
}

pub use zcode_cli_domain::config::ConfigSnapshot;

/// Layered zcode configuration for one workspace. Implementations reload files on
/// every call (Node reloads at each entry point); consumers only read snapshots.
#[async_trait]
pub trait ConfigSource: Send + Sync {
    async fn load(&self) -> Result<Arc<ConfigSnapshot>>;
    /// Switches one project hook in `<cwd>/.zcodium/config.json` if its
    /// declaration still has the reviewed digest. `Err` is a reason code.
    async fn set_workspace_hook_enabled(
        &self,
        _toggle: HookToggle,
    ) -> std::result::Result<(), &'static str> {
        Err("workspace_hooks_config_write_failed")
    }
}

/// A reviewed project hook declaration to switch (Node
/// `writeWorkspaceHookConfiguredToggle`).
pub struct HookToggle {
    pub path: String,
    pub event: zcode_cli_domain::hooks::HookEvent,
    pub relative_path: String,
    pub discovery_order: usize,
    pub matcher_index: usize,
    pub hook_index: usize,
    pub digest: String,
    pub resolved_timeout_ms: u64,
    pub resolved_max_output_bytes: u64,
    pub enabled: bool,
}

#[async_trait]
pub trait ContextPort: Send + Sync {
    fn desktop(&self) -> bool;
    async fn snapshot(
        &self,
        cancel: &CancellationToken,
    ) -> Result<zcode_cli_domain::prompt::PromptSnapshot>;
    async fn instructions(
        &self,
        cancel: &CancellationToken,
    ) -> Result<Vec<zcode_cli_domain::prompt::InstructionSource>>;
}
pub struct RuntimePorts {
    pub context: Arc<dyn ContextPort>,
    pub store: Arc<dyn SessionStore>,
    pub model: Option<Arc<dyn ModelPort>>,
    pub tools: Arc<dyn ToolPort>,
    pub clock: Arc<dyn RuntimeClock>,
}
