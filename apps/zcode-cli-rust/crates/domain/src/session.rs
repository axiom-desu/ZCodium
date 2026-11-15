use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub media_type: String,
    /// The content bytes (decoded when `data_url`).
    pub total_bytes: u64,
    /// `path` is a Node data URL artifact (`data:<mime>;base64,...`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub data_url: bool,
    /// The Node resolution of a prompt attachment (spec rust-m11-node-storage §5.3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<super::node_journal::files::NodeFile>,
    /// What this run's requests send instead (Node sends a prepared uploaded
    /// image live while its artifact keeps the original).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared: Option<Box<StoredAttachment>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// The Node records of this session still to be written, and the Node ids
    /// of its current turn (spec rust-m11-node-storage §5.1).
    #[serde(default)]
    pub node: super::node_journal::NodeJournal,
    #[serde(default)]
    pub file_checkpoints: Vec<super::file_checkpoint::FileCheckpoint>,
    /// Stored Node checkpoints of a resumed session, turned into
    /// `file_checkpoints` once the tools hold their contents.
    #[serde(skip)]
    pub imported_checkpoints: Vec<super::file_checkpoint::ImportedCheckpoint>,
    /// A resumed Node session's context use (the model's window is added by
    /// the engine, as Node's cold usage seed).
    #[serde(skip)]
    pub cold_context_used: Option<u64>,
    /// The main-turn requests' cache use by model message (spec
    /// rust-m9-usage-logs §4.2); rebuilt from the stored branch on load.
    #[serde(skip)]
    pub cache_hits: crate::usage::CacheHits,
    /// The session's live event sequence (Node `SessionEvent.sequenceNumber`)
    /// of this process.
    #[serde(skip)]
    pub event_seq: u64,
    #[serde(default)]
    pub rewind_committed: Option<String>,
    #[serde(default, skip_serializing)]
    pub history: super::history::History,
    #[serde(default)]
    pub row_highwater: u64,
    #[serde(skip)]
    pub history_rewrite: bool,
    #[serde(default)]
    pub agent_profile: Option<super::subagent::Profile>,
    #[serde(default)]
    pub children: std::collections::BTreeMap<String, super::subagent::Task>,
    #[serde(default)]
    pub mailbox: Vec<Value>,
    #[serde(default)]
    pub goal: Option<super::goal::Goal>,
    #[serde(default)]
    pub skills: Option<super::skills::SkillCatalog>,
    #[serde(default)]
    pub shared_context: Option<super::shared_context::SharedContext>,
    #[serde(default)]
    pub legacy_shared_context: bool,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub workspace_directory: Option<String>,
    #[serde(default)]
    pub trace_id: Option<String>,
    /// Root trace of this process's runtime for the session (Node creates one
    /// per app instance and never persists it); used for model attribution.
    #[serde(skip)]
    pub runtime_trace: Option<String>,
    #[serde(default)]
    pub todos: Vec<super::todo::TodoItem>,
    #[serde(default)]
    pub todos_updated_at: u64,
    #[serde(default)]
    pub prompt_snapshot: Option<super::prompt::PromptSnapshot>,
    /// 3.18 F1：指令文件读取缓存（会话开始与 compaction 后重读；进程内，不落库）。
    #[serde(skip)]
    pub instructions: Option<std::sync::Arc<[super::instruction_files::File]>>,
    /// 读取缓存对应的压缩边界（`context.offset`）；不同即重读。
    #[serde(skip)]
    pub instructions_boundary: Option<usize>,
    /// 最近一次读取中**存在但读不出来**的指令路径；增量公告不算删除。
    #[serde(skip)]
    pub instructions_unreadable: Option<std::sync::Arc<[String]>>,
    /// 3.18 F12：本会话用过的能力标签（只增不减；冷恢复从 entry ∪ 历史推导）。
    #[serde(skip)]
    pub session_features: std::collections::BTreeSet<String>,
    /// 3.18 F4：最近一次请求的 context composition（进程内缓存，查询按 revision 对账）。
    #[serde(skip)]
    pub context_composition: Option<serde_json::Value>,
    /// 3.18 F4：每会话递增的 composition 修订号。
    #[serde(skip)]
    pub context_composition_revision: u64,
    /// 3.18 F2：主会话 total_tokens 预算（只在内存，resume 重新起算）。
    #[serde(skip)]
    pub total_tokens: super::total_tokens::Budget,
    /// 3.18 F3：主会话 system 字节快照（进程内视图；冷恢复来源是 session_entry）。
    #[serde(skip)]
    pub prompt_system: Option<serde_json::Value>,
    /// The stored `envInfo` of a resumed session (Node `extractPersistedEnvInfo`),
    /// the environment of its next prompt snapshot.
    #[serde(skip)]
    pub stored_env: Option<Value>,
    #[serde(default)]
    pub context: super::context::ContextState,
    #[serde(skip)]
    pub context_tokens: Option<usize>,
    #[serde(skip)]
    pub compact_instructions: Option<String>,
    #[serde(skip)]
    pub queued_now: Option<String>,
    #[serde(skip)]
    pub pending_acks: std::collections::BTreeMap<String, Value>,
    /// Missing in legacy native sessions: those deserialize as build.
    #[serde(default)]
    pub mode: super::execution::Mode,
    #[serde(default)]
    pub plan_enabled: bool,
    /// Last tool-driven plan transition `{toolCallId, planEnabled}` (V4 `config.planTransition`).
    #[serde(default)]
    pub plan_transition: Option<Value>,
    /// Interaction whose full-access approval switched this session to yolo.
    #[serde(default)]
    pub permission_grant: Option<String>,
    /// Mode recorded with the last assistant message (Node `info.mode`); a legacy
    /// cold `session/resume` restores it.
    #[serde(default)]
    pub last_assistant_mode: Option<String>,
    #[serde(skip)]
    pub runtime: super::session_runtime::RuntimeOptions,
    /// Plan was just turned off; the next model request says so once (memory only).
    #[serde(skip)]
    pub needs_plan_exit_reminder: bool,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default = "interactive")]
    pub task_type: String,
    #[serde(default)]
    pub archived_at: Option<u64>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default = "yes")]
    pub listed: bool,
    #[serde(default)]
    pub attachments: std::collections::BTreeMap<String, StoredAttachment>,
    #[serde(default)]
    pub background: std::collections::BTreeMap<String, super::background::BackgroundTask>,
    pub id: String,
    pub workspace: String,
    pub title: String,
    pub title_source: String,
    pub provider: String,
    pub model: String,
    pub reasoning_level: String,
    #[serde(default)]
    pub thought_levels: Vec<String>,
    pub epoch: String,
    pub seq: u64,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub phase: super::execution::Phase,
    #[serde(default, skip_serializing)]
    pub rows: Vec<Value>,
    #[serde(default, skip_serializing)]
    pub messages: Vec<Value>,
    #[serde(skip)]
    pub saved_rows: usize,
    #[serde(skip)]
    pub resident_bytes: Option<usize>,
    /// Retained deltas and the last published patch of the conversation topic.
    #[serde(skip)]
    pub topic: super::topic_log::ConversationTopic,
    #[serde(skip)]
    pub saved_inputs: usize,
    #[serde(skip)]
    pub saved_responses: usize,
    #[serde(skip)]
    pub saved_messages: usize,
    #[serde(skip)]
    pub checkpoint_at: u64,
    #[serde(skip)]
    pub api_retry: Option<super::model::RetryState>,
    pub usage: Value,
    pub last_error: Option<Value>,
    #[serde(default)]
    pub creation_ack: Option<(String, Value)>,
    #[serde(default)]
    pub pending: Vec<Value>,
    #[serde(skip)]
    pub queue: Vec<Value>,
    #[serde(default = "yes")]
    pub auto_drain: bool,
    #[serde(default = "queue_mode")]
    pub followup_mode: String,
    #[serde(skip)]
    pub run_id: Option<String>,
}
fn queue_mode() -> String {
    "queue".into()
}
fn interactive() -> String {
    "interactive".into()
}
fn yes() -> bool {
    true
}

#[path = "session_impl.rs"]
mod session_impl;
