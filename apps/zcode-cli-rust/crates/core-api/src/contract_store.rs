// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! The `SessionStore` port: durable session, ledger, ACK, attachment and
//! read-only history access. Adapters own the IO; the application owns state.
use crate::contract::DurableCommitReceipt;
use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::BTreeMap;
use zcode_cli_domain::session::Session;

#[async_trait]
pub trait SessionStore: Send + Sync {
    /// The store keeps Node session records (spec rust-m11-node-storage §5.1):
    /// the engine then queues them on `Session.node` for `commit`.
    fn node_journal(&self) -> bool {
        false
    }
    /// Startup reads only the lightweight persisted index, never every transcript or ACK.
    async fn load_index(&self, workspace: &str) -> Result<BTreeMap<String, Value>>;
    /// Read one durable receipt, disposing a cold queued input without hydrating its session.
    async fn lookup_ack(&self, workspace: &str, key: &str) -> Result<Option<Value>>;
    /// `lookup_ack` knowing whether the key's session has a live runtime here;
    /// a cold lookup may settle its admitted inputs (Node `discardAdmittedOnLoad`).
    async fn lookup_ack_live(
        &self,
        workspace: &str,
        key: &str,
        _live: bool,
    ) -> Result<Option<Value>> {
        self.lookup_ack(workspace, key).await
    }
    /// Read persisted identities without loading history, resuming a runtime, or writing storage.
    async fn list_sessions(
        &self,
        _params: &zcode_cli_domain::session_listing::ListParams,
        _owner: (&str, &str),
    ) -> Result<Vec<zcode_cli_domain::session_listing::SessionListing>> {
        anyhow::bail!("Session listing unavailable")
    }
    /// 任意身份的持久会话事实（含软删）；显式会话 ID 预留不得覆盖它。
    async fn session_exists(&self, _id: &str) -> Result<bool> {
        Ok(false)
    }
    /// `v4/sessionsIndex/reconcile`：按明确 ID 只读持久事实（含软删），不激活 runtime。
    /// 默认显式失败，调用方不得把缺席当删除或降级为空成功。
    async fn reconcile_sessions(&self, _workspace_id: &str, _ids: &[String]) -> Result<Value> {
        anyhow::bail!("Sessions index reconcile unavailable")
    }
    /// Load one persisted conversation through the recovery/activation owner.
    async fn load_session(&self, _workspace: &str, _id: &str) -> Result<Option<Session>> {
        anyhow::bail!("Single session loading unavailable")
    }
    /// Pure snapshot read: must not activate, recover, or write the session.
    async fn read_session(&self, _workspace: &str, _id: &str) -> Result<Option<Session>> {
        anyhow::bail!("Read-only session snapshot unavailable")
    }
    /// Node `softDeleteSession(id, at)`: the durable "deleted" fact (coalesce keeps the
    /// first time, so repeats are idempotent). `workspace` scopes the write to this
    /// identity's row; another workspace's session is refused, never deleted.
    async fn soft_delete_session(&self, _workspace: &str, _id: &str, _at: u64) -> Result<()> {
        anyhow::bail!("Session soft deletion unavailable")
    }
    /// Node `listSessionSubagents`' stored facts of `parent`; `None` without a
    /// session row.
    async fn subagent_facts(
        &self,
        _parent: &str,
        _live: zcode_cli_domain::subagent_query::Live,
    ) -> Result<Option<zcode_cli_domain::subagent_query::StoredFacts>> {
        Ok(None)
    }
    /// Workspace-scoped settings (Node `local_setting` scope `project`), e.g.
    /// `permission/ruleset` and `permission/mode`.
    async fn project_settings(
        &self,
        _workspace: &str,
    ) -> Result<BTreeMap<(String, String), Value>> {
        Ok(BTreeMap::new())
    }
    async fn save_project_setting(
        &self,
        _workspace: &str,
        _namespace: &str,
        _key: &str,
        _value: &Value,
    ) -> Result<()> {
        anyhow::bail!("Project settings unavailable")
    }
    /// Reclaim only a draft with no history, atomically with the close receipt.
    async fn discard_draft(
        &self,
        _workspace: &str,
        _id: &str,
        _ack: Option<(String, Value)>,
    ) -> Result<()> {
        anyhow::bail!("Draft reclamation unavailable")
    }
    /// Stores prompt attachment bytes of `session` in an artifact named after
    /// `call` (spec rust-m11-node-storage §5.3); returns its
    /// `zcode-artifact://` reference and the stored bytes.
    async fn put_attachment(
        &self,
        _session: &str,
        _call: &str,
        _chunks: &[Vec<u8>],
        _mime: &str,
    ) -> Result<(String, zcode_cli_domain::session::StoredAttachment)> {
        anyhow::bail!("Attachment storage unavailable")
    }
    /// Resolves the local path attachment at `index` the way Node does:
    /// `(original, path)` is the submitted reference and its resolved file.
    /// Returns the reference the input keeps and the stored resolution.
    async fn local_attachment(
        &self,
        _session: &str,
        _index: usize,
        _file: (&str, &str),
        _mime: &str,
    ) -> Result<(String, zcode_cli_domain::session::StoredAttachment)> {
        anyhow::bail!("Attachment snapshot unavailable")
    }
    /// Writes a text artifact of `session` named after `call` (Node
    /// `writeToolResultArtifact`); returns its `zcode-artifact://` URI.
    async fn write_artifact(
        &self,
        _session: &str,
        _call: &str,
        _content: &str,
        _content_type: &str,
    ) -> Result<String> {
        anyhow::bail!("Artifact storage unavailable")
    }
    /// Node `prepareImageDataUrl` of an uploaded image at `index` of the
    /// input: its resolved file, and the prepared asset this run's requests
    /// send when it differs from the upload (spec rust-m11-node-storage §5.3).
    async fn uploaded_image(
        &self,
        reference: &str,
        asset: &zcode_cli_domain::session::StoredAttachment,
        file_name: &str,
        index: usize,
    ) -> Result<(
        zcode_cli_domain::node_journal::files::NodeFile,
        Option<zcode_cli_domain::session::StoredAttachment>,
    )> {
        use zcode_cli_domain::node_journal::files::{Media, media};
        let file = media(Media {
            uri: reference,
            mime: &asset.media_type,
            bytes: asset.total_bytes,
            file_name,
            index,
            local: None,
            image: None,
        });
        Ok((file, None))
    }
    /// The stored bytes behind a reference the session does not hold in
    /// memory (a resumed or Node-written session).
    async fn attachment_of(
        &self,
        _reference: &str,
    ) -> Result<Option<zcode_cli_domain::session::StoredAttachment>> {
        Ok(None)
    }
    async fn read_attachment(
        &self,
        _asset: &zcode_cli_domain::session::StoredAttachment,
        _offset: u64,
        _limit: usize,
    ) -> Result<Vec<u8>> {
        anyhow::bail!("Attachment read unavailable")
    }
    /// Appends one usage fact through the storage writer without waiting for
    /// it; failures are logged by the store and never reach the caller.
    async fn record_usage(&self, _fact: zcode_cli_domain::usage::Fact) {}
    /// Node `queryAppUsage` over the whole database, after every usage fact
    /// sent before the call was written.
    async fn app_usage(
        &self,
        _since: i64,
        _until: i64,
        _tz_offset_ms: i64,
    ) -> Result<zcode_cli_domain::usage::AppRows> {
        Ok(Default::default())
    }
    /// One session's model requests in `started_at, id` order (same barrier).
    async fn task_usage(&self, _session_id: &str) -> Result<Vec<zcode_cli_domain::usage::TaskRow>> {
        Ok(vec![])
    }
    /// The workspace's `skip`-th latest `sendText` history entry (spec
    /// cli-rust-tui-workbench §1), as `InputHistoryEntry` JSON; `None` past the
    /// end. `workspace` is the full identity key. History is an optional port:
    /// the default body explicitly answers `unsupported` (never an empty read),
    /// and that unsupported answer must not fail ordinary admission of stores
    /// that keep no input history.
    async fn recall_input_history(&self, _workspace: &str, _skip: u32) -> Result<Option<Value>> {
        anyhow::bail!("Input history unavailable")
    }
    async fn load(&self, workspace: &str) -> Result<(Vec<Session>, BTreeMap<String, Value>)>;
    async fn commit(
        &self,
        workspace: &str,
        session: Option<&mut Session>,
        ack: Option<(String, Value)>,
    ) -> Result<()>;

    async fn commit_receipt(
        &self,
        workspace: &str,
        session: Option<&mut Session>,
        ack: Option<(String, Value)>,
    ) -> Result<DurableCommitReceipt> {
        let session_id = session.as_ref().map(|value| value.id.clone());
        let sequence = session.as_ref().map(|value| value.seq).unwrap_or_default();
        self.commit(workspace, session, ack).await?;
        let receipt_id = format!(
            "{}:{}:{}",
            workspace,
            session_id.as_deref().unwrap_or("workspace"),
            sequence
        );
        Ok(DurableCommitReceipt {
            receipt_id,
            workspace: workspace.to_owned(),
            session_id,
            sequence,
        })
    }
}
