//! Tool call row completion (Node `permission_denied` / failed tool semantics),
//! split out of `event_projection.rs` for the 400-line boundary.
use crate::domain::session::Session;
use serde_json::{Value, json};

/// One finished tool call's row facts.
pub(super) struct Done<'a> {
    pub result: &'a str,
    pub display: Option<&'a Value>,
    pub failed: bool,
    /// Permission denied: `cancelled`, never a tool error (Node `permission_denied`).
    pub denied: bool,
}

/// Closes the running row of `call_id` and returns the `row.upserted` delta row.
/// 与 Node 一致：被拒绝的调用不产生工具错误，行收口为 cancelled。
pub(super) fn finish_call(
    session: &mut Session,
    (turn, call_id): (&str, &str),
    now: u64,
    done: Done<'_>,
) -> Option<Value> {
    let row = session
        .rows
        .iter_mut()
        .find(|r| r["turnId"] == turn && r["toolCallId"] == call_id)?;
    row["status"] = if done.denied {
        "cancelled"
    } else if done.failed {
        "error"
    } else {
        "success"
    }
    .into();
    row["endedAt"] = now.into();
    row["output"] = json!({"text": done.result});
    if let Some(display) = done.display {
        row["output"]["display"] = display.clone();
    }
    row.as_object_mut().unwrap().remove("approvalInteractionId");
    if done.failed && !done.denied {
        row["error"] = json!({"code":"fault.tool.failed","message":"Tool execution failed"});
    }
    Some(row.clone())
}
