//! 上游 3.18.2 F2：每条请求的 `total_tokens` 提醒。
//! 语义见 `.agents/specs/upstream-3.18-rust-context.md`。
//!
//! 预算所有者是 Engine 的 `Session.event` 之外的 `Session.total_tokens`（run 只持副本并
//! 每步把新状态交回 owner）；提醒本身只是本请求的附件，不进模型历史，也不落库。
use super::context::RunContext;
use crate::domain::total_tokens::{self, Collection};
use serde_json::{Value, json};

/// 这一步跟在什么后面：真实用户输入（轮首）或工具批次之后的步才提醒。
fn collection(history: &RunContext) -> Option<Collection> {
    let last = history
        .messages
        .iter()
        .rev()
        // 提醒消息（`_zcode_source`）不是这一步的输入；跳过看真正的最后一条。
        .find(|message| message["_zcode_source"].as_str().is_none())?;
    match last["role"].as_str() {
        // 通知、goal 续跑、压缩摘要这类 user 消息都带 `_zcode_source`，不会走到这里。
        Some("user") => Some(Collection::TurnInput),
        Some("tool") => Some(Collection::ToolBatch),
        _ => None,
    }
}

/// 构造本步的提醒消息；不提醒时返回 `None`。
/// 子代理不重新锚定也不消耗主会话预算：它们没有共享的计数器。
pub(super) fn next(history: &mut RunContext) -> Option<Value> {
    let collection = collection(history)?;
    let main_session = !history.subagent;
    let (emit, reanchor) = total_tokens::decide(
        collection,
        main_session,
        collection == Collection::TurnInput,
    );
    if !emit {
        return None;
    }
    if reanchor {
        history.total_tokens.reanchor(history.last_context);
    }
    let remaining = history.total_tokens.consume(history.last_context);
    let body = total_tokens::format_reminder(remaining);
    Some(json!({
        "role": "user",
        "content": crate::domain::node_history::reminders::wrap("total_tokens_reminder", &body),
        "_zcode_source": "total_tokens_reminder",
    }))
}

/// 每一步替换上一次的提醒：残留的旧倒数不能和新倒数一起发出去。
pub(super) fn remind(history: &mut RunContext) {
    let message = next(history);
    history.clear_budget_reminder();
    if let Some(message) = message {
        history.set_budget_reminder(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::total_tokens::TOTAL_TOKENS_BUDGET;

    fn completed(usage: u64) -> RunContext {
        let mut history = RunContext::new(Default::default(), vec![], None, 0);
        history.last_context = usage;
        history
    }

    fn message(source: &str) -> Value {
        json!({"role":"user","content":"x","_zcode_source":source})
    }

    #[test]
    fn a_real_user_turn_announces_and_reanchors() {
        let mut history = completed(1_200);
        history.messages.push(json!({"role":"user","content":"hi"}));
        let reminder = next(&mut history).unwrap();
        assert_eq!(
            reminder["content"],
            "<system-reminder>\n<total_tokens>15000000 tokens left</total_tokens>\n</system-reminder>"
        );
        assert_eq!(history.total_tokens.anchor, 1_200);
        assert_eq!(history.total_tokens.max_used, 0);
    }

    #[test]
    fn a_tool_batch_announces_without_reanchoring() {
        let mut history = completed(1_200);
        history.messages.push(json!({"role":"user","content":"hi"}));
        next(&mut history);
        history.messages.push(json!({"role":"tool","content":"r"}));
        history.last_context = 5_000;
        let reminder = next(&mut history).unwrap();
        assert!(
            reminder["content"]
                .as_str()
                .unwrap()
                .contains(&format!("{} tokens left", TOTAL_TOKENS_BUDGET - 3_800))
        );
        assert_eq!(history.total_tokens.anchor, 1_200);
    }

    #[test]
    fn reminders_and_assistant_turns_do_not_announce() {
        let mut history = completed(10);
        history
            .messages
            .push(json!({"role":"assistant","content":"done"}));
        assert!(next(&mut history).is_none());
        history.messages.push(message("total_tokens_reminder"));
        assert!(next(&mut history).is_none(), "a reminder is not an input");
        history.messages.push(message("target_continuation"));
        assert!(
            next(&mut history).is_none(),
            "goal continuation never reminds"
        );
    }

    #[test]
    fn a_subagent_step_neither_reminds_nor_consumes_a_shared_budget() {
        let mut history = completed(1_200);
        history.messages.push(json!({"role":"user","content":"hi"}));
        history.subagent = true;
        assert!(next(&mut history).is_none());
        assert_eq!(history.total_tokens.max_used, 0);
    }

    #[test]
    fn each_step_replaces_the_previous_reminder() {
        let mut history = completed(100);
        history.messages.push(json!({"role":"user","content":"hi"}));
        remind(&mut history);
        let first = history.budget_reminder().cloned().unwrap();
        history.messages.push(json!({"role":"tool","content":"r"}));
        history.last_context = 900;
        remind(&mut history);
        let budget: Vec<_> = history.budget_reminders().collect();
        assert_eq!(budget.len(), 1, "the old countdown is dropped");
        assert_ne!(budget[0], &first);
    }
}
