// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! Host authority over the automation that triggered the current run
//! (Node `AutomationPort.pause`, `automation/pause`).
//!
//! 身份边界：目标 automationId 只由 Host 准入并随输入注入本轮；port 不接受外部 id，
//! 也不缓存 Host 结论。Host 报错、协议不支持（`-32601`）与取消都是错误，不能当成
//! “未暂停”的布尔。
use anyhow::Result;
use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait AutomationPort: Send + Sync {
    /// The Host-admitted automation id of this run; `None` for a user turn,
    /// a resumed continuation without an admitted id, or a subagent run.
    fn self_id(&self) -> Option<&str>;
    /// Pauses that automation through the Host. `false` is the Host's own
    /// conclusion (already paused/completed/failed/deleted), never a fallback
    /// for a failed or missing reply.
    async fn pause_self(&self, cancel: &CancellationToken) -> Result<bool>;
}
