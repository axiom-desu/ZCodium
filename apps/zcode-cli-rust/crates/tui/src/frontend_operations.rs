//! 操作回包的唯一前端结算点（spec cli-rust-tui-responsive-operations §输入与草稿规则）。
//!
//! 只消费 `Client` 已完成队列里的票据回包；这里不发送、不等待新 ACK，也不拥有第二份
//! 可写草稿。迟到/旧世代效果由 `Operations::accepted/rejected` 的归属校验丢弃。
use crate::{
    client::Client,
    client_operations::TicketKind,
    operations::{Attribution, OpKind},
    projection::View,
    session,
};
use anyhow::Result;
use serde_json::Value;

fn rejection_message(view: &View, ack: Option<&Value>, error: Option<&str>) -> String {
    if ack.and_then(|ack| ack["reasonCode"].as_str()) == Some("heldQueueDispositionRequired") {
        return view
            .text(
                "The queue is paused with queued input, so the draft was not submitted (heldQueueDispositionRequired). Use /queue resume to continue it, or /queue list to inspect and clean it.",
                "队列已暂停且仍有排队输入，草稿未提交（heldQueueDispositionRequired）。请使用 /queue resume 恢复队列，或用 /queue list 查看并清理旧项。",
            )
            .to_owned();
    }
    error
        .map(str::to_owned)
        .or_else(|| {
            ack.and_then(|ack| {
                ack["message"]
                    .as_str()
                    .or(ack["reasonCode"].as_str())
                    .map(str::to_owned)
            })
        })
        .unwrap_or_else(|| "Command was not accepted".to_owned())
}

fn reject(
    view: &mut View,
    kind: OpKind,
    session: &str,
    generation: u64,
    epoch: u64,
    message: String,
) -> bool {
    let (attribution, stored) = view
        .operations
        .rejected(session, generation, kind, Some(epoch));
    if attribution == Attribution::Stale {
        return false;
    }
    view.pending_submit = false;
    let mut note = format!("Error: {message}");
    if !stored && view.operations.busy() {
        // 恢复槽已满：`rejected` 没有 take，调用方必须显式拿回这份草稿；若两个
        // 可恢复位置也满，则保留原 inflight 并保持门禁，绝不静默丢稿。
        let editor_free = view.editor.text().is_empty() && view.draft_attachments.is_empty();
        if !editor_free && !view.operations.pending_slot_free() {
            note.push_str(view.text(
                " The recovery slots are full; the failed draft is still held by the operation. Resolve /draft first.",
                " 恢复槽已满；失败草稿仍由该操作保留。请先处理 /draft。",
            ));
            view.push(&note);
            return true;
        }
        if let Some(draft) = view.operations.abort() {
            if editor_free {
                view.editor.replace_all(&draft.text);
                view.draft_attachments = draft.attachments;
            } else {
                view.operations.keep_pending(session, generation, draft);
            }
        }
        note.push_str(view.text(
            " The failed draft was kept for explicit recovery; it was not retried.",
            " 失败草稿已保留供显式恢复；未自动重试。",
        ));
        view.push(&note);
        return true;
    }
    if stored {
        // 等待期间已有新正文/附件：保留新草稿，并把被拒那份留在唯一拒绝槽供 Ctrl-Y 交换。
        let has_new = !view.editor.text().trim().is_empty() || !view.draft_attachments.is_empty();
        if !has_new {
            if let Some(rejected) = view.operations.take_rejected() {
                view.editor.replace_all(&rejected.draft.text);
                view.draft_attachments = rejected.draft.attachments;
                if rejected.session != session {
                    note.push_str(view.text(
                        " (draft restored from another session; review before sending)",
                        "（草稿来自其他会话，发送前请确认）",
                    ));
                }
            }
        } else {
            note.push_str(view.text(
                " The rejected draft is kept; press Ctrl-Y to swap it in, Ctrl-Shift-Y to discard it.",
                " 被拒绝的草稿已保留；按 Ctrl-Y 交换进来，按 Ctrl-Shift-Y 丢弃。",
            ));
        }
    }
    view.push(&note);
    true
}

/// Ctrl-Y / Ctrl-Shift-Y 的唯一实现：交换或显式丢弃那一份恢复草稿。
///
/// 交换是纯本地动作，不发请求、不拼接文本、不跨会话重发；空编辑器交换会清空
/// alternate 槽，因此不会出现“recover 后永远 has_rejected”的死锁。
pub(crate) fn swap_alternate(view: &mut View, discard: bool) {
    if discard {
        match view.operations.discard_rejected(&view.session) {
            Some(len) => {
                let note = if view.zh {
                    format!("已丢弃这份恢复草稿（{len} 字符）；现在可以继续提交。")
                } else {
                    format!(
                        "The alternate draft was discarded ({len} chars); you can submit again."
                    )
                };
                view.push(&note);
            }
            None => {
                let note = view
                    .text("No alternate draft to discard.", "没有可丢弃的恢复草稿。")
                    .to_owned();
                view.push(&note);
            }
        }
        return;
    }
    // 先无副作用地把当前草稿做成候选：没有可恢复草稿时不能提前 take 附件，
    // 否则 Ctrl-Y/斜杠命令会无声丢掉用户当前附件。
    let current = crate::operations::SentDraft::new(
        view.editor.text().to_owned(),
        view.draft_attachments.clone(),
    );
    match view
        .operations
        .swap_rejected(&view.session, view.generation, current)
    {
        Some(swapped) => {
            view.editor.replace_all(&swapped.restored.text);
            view.draft_attachments = swapped.restored.attachments;
            view.history.edited();
            if swapped.unknown_outcome {
                let note = view
                    .text(
                        "This draft was already sent but its result is unknown; review it before sending again.",
                        "这份草稿已发送但结果未知；再次发送前请先复核。",
                    )
                    .to_owned();
                view.push(&note);
            }
            if swapped.kept.is_none() {
                let note = view
                    .text(
                        "The alternate draft is now empty and cleared; you can submit again.",
                        "交换后的备用草稿为空并已清空；现在可以继续提交。",
                    )
                    .to_owned();
                view.push(&note);
            }
        }
        None => {
            // 当前 editor/附件保持原样（未 take、未覆盖）。
            let note = view
                .text(
                    "No rejected draft from this session can be restored; the current draft and attachments were kept.",
                    "当前会话没有可恢复的被拒绝草稿；当前草稿与附件已保留。",
                )
                .to_owned();
            view.push(&note);
        }
    }
}

/// boot/setting/queue 在飞时依赖会话事实的命令必须显式拒绝并保留草稿。
pub(crate) fn busy_slash_error(view: &View) -> anyhow::Error {
    anyhow::anyhow!(
        "{}",
        view.text(
            "The session is still opening or another operation is waiting for the actor; the command was not sent and the draft was kept. Wait for it to finish and press Enter again.",
            "会话仍在打开或已有操作在等待 actor 回包；命令未发送，草稿已保留。请等待完成后再按 Enter。"
        )
    )
}

/// `/draft` 的纯本地状态行：只报告恢复槽状态，不发送、不丢稿。
pub(crate) fn draft_status(view: &View) -> String {
    match view.operations.recoverable(&view.session) {
        Some((len, true)) => {
            if view.zh {
                format!(
                    "还保留着一份结果未知的旧草稿（{len} 字符，已发送过）。使用 /draft swap 复核，或用 /draft discard 显式丢弃；不会自动重发。"
                )
            } else {
                format!(
                    "An older draft with unknown outcome is kept ({len} chars; it was already sent). Use /draft swap to review it, or /draft discard to drop it explicitly; it will not be resent automatically."
                )
            }
        }
        Some((len, false)) => {
            if view.zh {
                format!(
                    "还保留着一份被拒绝的草稿（{len} 字符）。使用 /draft swap 复核，或用 /draft discard 显式丢弃。"
                )
            } else {
                format!(
                    "A rejected draft is kept ({len} chars). Use /draft swap to review it, or /draft discard to drop it explicitly."
                )
            }
        }
        None if view.operations.has_rejected() => view
            .text(
                "A rejected/unknown-outcome draft from another session is kept. /draft swap only restores it in its original session; use /draft discard to drop it explicitly.",
                "还保留着另一会话的被拒绝/结果未知草稿。/draft swap 只能回到原会话恢复；可用 /draft discard 显式丢弃。",
            )
            .to_owned(),
        None => view
            .text(
                "No alternate draft is kept; the current editor content is unchanged.",
                "当前没有备用草稿；编辑器内容保持不变。",
            )
            .to_owned(),
    }
}

/// 每轮主循环有界结算所有已完成票据；返回是否需要重绘。
///
/// draft 票据走原 accepted/rejected 归属校验；flow 票据推进 boot/setting/queue/picker/
/// snapshot 的续步。两者共用同一 token 分配器与同一个完成队列，绝不 await 新 ACK。
pub(crate) async fn settle(client: &mut Client<'_>, view: &mut View) -> Result<bool> {
    let mut dirty = false;
    for reply in client.take_operation_replies() {
        let (session, generation, epoch) = (reply.session.clone(), reply.generation, reply.epoch);
        let kind = match reply.kind {
            TicketKind::Draft(kind) => kind,
            TicketKind::Flow(slot) => {
                let result = reply.result.map_err(|error| error.to_string());
                dirty |= client.resume_flow(view, slot, epoch, generation, result)?;
                continue;
            }
        };
        dirty = true;
        match &reply.result {
            Ok(ack) => {
                let status = ack["status"].as_str().unwrap_or_default();
                let ok = status == "accepted" || (kind == OpKind::Stop && status == "noop");
                if ok {
                    view.operations
                        .accepted(&session, generation, kind, Some(epoch));
                    if kind != OpKind::Stop {
                        view.pending_submit = false;
                    }
                } else {
                    // 迟到/旧世代拒绝只是丢弃该效果，不能把本轮之前已经成功的
                    // workflow 效果（picker 打开、快照应用等）的 dirty 抹掉。
                    reject(
                        view,
                        kind,
                        &session,
                        generation,
                        epoch,
                        rejection_message(view, Some(ack), None),
                    );
                }
            }
            Err(error) => {
                reject(
                    view,
                    kind,
                    &session,
                    generation,
                    epoch,
                    rejection_message(view, None, Some(&error.to_string())),
                );
            }
        }
    }
    // optimistic overlay 只属于在飞 draft mutation：结算后不得残留。
    if !view.operations.busy() {
        view.pending_submit = false;
    }
    // 唯一 stop 等当前 draft 与 flow mutation 都结算后补发；不等待它的 ACK。
    if !client.mutation_flow_busy() && view.operations.take_queued_stop() {
        if let Err(error) = session::stop(client, view).await {
            view.push(&format!("Error: {error}"));
        }
        dirty = true;
    }
    Ok(dirty)
}
