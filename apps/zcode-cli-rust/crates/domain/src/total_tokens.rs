//! 上游 3.18.2 F2：`total_tokens` 预算（`.agents/specs/upstream-3.18-rust-context.md`）。
//!
//! 语义来源：官方 `core/src/context/total-tokens.ts` 与
//! `core/src/runtime/helpers/total-tokens-budget.ts`；跨压缩的扣减形状参照
//! MBearo/ZCode-rs `crates/context/src/announce.rs`（Apache-2.0，仅语义）。
use serde::{Deserialize, Serialize};

/// 模型可见的 token 预算；固定值，不提供模式或配置。
pub const TOTAL_TOKENS_BUDGET: u64 = 15_000_000;

/// system 末尾的固定行。
pub fn system_line() -> String {
    format_reminder(TOTAL_TOKENS_BUDGET)
}

pub fn format_reminder(remaining: u64) -> String {
    format!("<total_tokens>{remaining} tokens left</total_tokens>")
}

/// 本次收集附件的原因：决定提醒与重新锚定（官方 `InputAttachmentCollectionReason`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Collection {
    /// 轮首是输入（真实用户 prompt 或引导输入）。
    TurnInput,
    /// 工具批次之后。
    ToolBatch,
    /// 纯文本回复后取出的引导输入。
    TextGuide,
}

/// 每个 runtime 一份的预算计数（只在内存，resume 重新起算）。
/// 上下文 = 最近一条带 usage 的 assistant 的 input + output。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// 本 runtime 内 compaction 之前的上下文累计。
    pub rolled_over: u64,
    /// 最近一次重新起算时的 `rolled_over + context`。
    pub anchor: u64,
    /// 已用量只增不减；重新起算时归零。
    pub max_used: u64,
}

impl Budget {
    pub fn remaining(self) -> u64 {
        TOTAL_TOKENS_BUDGET.saturating_sub(self.max_used)
    }

    /// 重新起算：真实用户输入。
    pub fn reanchor(&mut self, context: u64) {
        self.anchor = self.rolled_over.saturating_add(context);
        self.max_used = 0;
    }

    /// compaction 成功后把压缩前上下文滚进累计，保留剩余额度。
    pub fn roll_over(&mut self, context: u64) {
        self.rolled_over = self.rolled_over.saturating_add(context);
    }

    /// 扣减并返回剩余；只增不减的 `max_used` 保证同一上下文不重复计费。
    pub fn consume(&mut self, context: u64) -> u64 {
        let used = self.max_used.max(
            self.rolled_over
                .saturating_add(context)
                .saturating_sub(self.anchor),
        );
        self.max_used = used;
        self.remaining()
    }
}

/// 这一步是否提醒、是否重新锚定。
/// 只有主会话里出自用户本人的输入重新起算；工具批次之后总是提醒。
pub fn decide(collection: Collection, main_session: bool, from_user: bool) -> (bool, bool) {
    let anchored = main_session && from_user;
    match collection {
        Collection::TurnInput => (anchored, anchored),
        Collection::ToolBatch => (true, false),
        Collection::TextGuide => (true, anchored),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminder_text_and_system_line_share_the_budget() {
        assert_eq!(system_line(), format_reminder(15_000_000));
        assert_eq!(
            format_reminder(0),
            "<total_tokens>0 tokens left</total_tokens>"
        );
    }

    #[test]
    fn consume_grows_the_used_amount_and_never_increases_the_remainder() {
        let mut budget = Budget::default();
        assert_eq!(budget.consume(100), TOTAL_TOKENS_BUDGET - 100);
        assert_eq!(budget.consume(60), TOTAL_TOKENS_BUDGET - 100);
        assert_eq!(budget.consume(140), TOTAL_TOKENS_BUDGET - 140);
    }

    #[test]
    fn compaction_rolls_over_and_keeps_the_countdown() {
        let mut budget = Budget::default();
        budget.reanchor(1_000);
        assert_eq!(budget.consume(1_500), TOTAL_TOKENS_BUDGET - 500);
        // compaction 之后窗口从 0 起算，但压缩前的用量已被滚进累计。
        budget.roll_over(1_500);
        assert_eq!(budget.consume(0), TOTAL_TOKENS_BUDGET - 500);
        // 压缩后的窗口从 0 开始长，剩余额度继续下降，不回满。
        assert_eq!(budget.consume(300), TOTAL_TOKENS_BUDGET - 800);
        // 用户亲手输入重新锚定，回到满额。
        budget.reanchor(300);
        assert_eq!(budget.consume(300), TOTAL_TOKENS_BUDGET);
    }

    #[test]
    fn only_a_main_session_user_input_reanchors() {
        assert_eq!(decide(Collection::TurnInput, true, true), (true, true));
        assert_eq!(decide(Collection::TurnInput, false, true), (false, false));
        assert_eq!(decide(Collection::TurnInput, true, false), (false, false));
        assert_eq!(decide(Collection::ToolBatch, true, false), (true, false));
        assert_eq!(decide(Collection::TextGuide, true, true), (true, true));
        assert_eq!(decide(Collection::TextGuide, true, false), (true, false));
    }
}
