//! 拒绝/结果未知草稿的显式恢复（Ctrl-Y 便捷键与 /draft 命令的唯一实现）。
//!
//! 从 `operations` 拆出以保持单文件上限；状态仍由 [`Operations`] 独占，这里只做
//! 交换/丢弃/只读摘要，不发送请求，也不跨会话自动恢复。
use crate::operations::{Operations, RejectedDraft, SentDraft, Swapped};

impl Operations {
    /// 立即取回拒绝草稿（失败发生在同一键处理内、没有新草稿时的整份恢复）。
    pub(crate) fn take_rejected(&mut self) -> Option<RejectedDraft> {
        self.rejected.take()
    }

    /// 恢复拒绝草稿：与主 editor 显式交换（Ctrl-Y），不拼接、不覆盖新正文、不跨会话重发。
    ///
    /// 返回值：
    /// - `Some((restored, kept))`：`restored` 交给 editor/draft；`kept` 是留在槽里的
    ///   alternate（`None` 表示交换进来的 current 为空，槽已清空，可以继续提交）；
    /// - `None`：没有可恢复草稿或来源 session 不同，调用方必须提示而不是静默丢弃。
    ///
    /// 旧世代/未知归属的草稿交换后变成用户当前编辑内容，因此升级为确定的可编辑草稿。
    pub(crate) fn swap_rejected(
        &mut self,
        session: &str,
        generation: u64,
        current: SentDraft,
    ) -> Option<Swapped> {
        let rejected_match = self
            .rejected
            .as_ref()
            .is_some_and(|entry| entry.session == session);
        let pending_match = !rejected_match
            && self
                .pending
                .as_ref()
                .is_some_and(|entry| entry.session == session);
        let slot = if rejected_match {
            &mut self.rejected
        } else if pending_match {
            &mut self.pending
        } else {
            return None;
        };
        let entry = slot.as_mut()?;
        let unknown_outcome = entry.draft.unknown;
        let restored = std::mem::replace(&mut entry.draft, current);
        // 旧世代草稿可以恢复到新 editor 继续编辑，但 unknown 标签跟随草稿本身；
        // 交换不会把“结果未知”洗成已知，也不会把标签贴到交换进来的新草稿上。
        entry.generation = generation;
        if entry.draft.text.is_empty() && entry.draft.attachments.is_empty() {
            // 交换进来的是空草稿：alternate 没有数据，必须清槽，否则 recover 后永久阻塞提交。
            *slot = None;
            return Some(Swapped {
                restored,
                kept: None,
                unknown_outcome,
            });
        }
        let kept = entry.draft.clone();
        Some(Swapped {
            restored,
            kept: Some(kept),
            unknown_outcome,
        })
    }

    /// 用户显式丢弃 alternate（`/draft discard`；组合键仅在终端能区分时作为便捷方式）。
    /// 这是唯一允许主动丢稿的路径。
    ///
    /// 返回被丢弃的草稿摘要（正文长度），`None` 表示没有可丢弃内容。
    pub(crate) fn discard_rejected(&mut self, session: &str) -> Option<usize> {
        let rejected_match = self
            .rejected
            .as_ref()
            .is_some_and(|entry| entry.session == session);
        let pending_match = !rejected_match
            && self
                .pending
                .as_ref()
                .is_some_and(|entry| entry.session == session);
        // 显式丢弃是用户主动删除，不跨会话重发；因此即使槽里是旧会话的草稿也必须
        // 可清空，否则恢复槽会永久阻塞新会话提交（死锁）。
        let target = if rejected_match {
            self.rejected.take()
        } else if pending_match {
            self.pending.take()
        } else {
            self.rejected.take().or_else(|| self.pending.take())
        }?;
        Some(target.draft.text.chars().count())
    }
}
