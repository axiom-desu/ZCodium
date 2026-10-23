//! 输入历史只读回包的唯一应用点：验证会话/世代后写回未提交草稿。
use crate::{
    client::{QueryKind, ReadReply},
    input_history::{Applied, Draft},
    projection::View,
};

pub(crate) fn apply_history(view: &mut View, reply: ReadReply) -> bool {
    let QueryKind::History { skip } = reply.kind else {
        return false;
    };
    if reply.session != view.session || reply.generation != view.generation {
        return false;
    }
    // 审批/问答、selector 或队列编辑会接管主 editor；同 session/generation 也不能把
    // 迟到的历史正文写进回答草稿。清掉 pending/revision，后续 ↑ 重新按当前上下文开始。
    if view.interaction().is_some() || view.selector.is_some() || view.queue_edit.is_some() {
        view.history.edited();
        return false;
    }
    let directory = view.directory.clone();
    let applied = view.history.apply(
        &view.session,
        view.generation,
        skip,
        reply.result,
        &directory,
    );
    match applied {
        Applied::Restore(draft) => {
            restore(view, draft);
            true
        }
        Applied::End => {
            let note = view
                .text("No earlier input history.", "没有更早的输入历史。")
                .to_owned();
            view.push(&note);
            true
        }
        Applied::Failed(error) => {
            let lowered = error.to_lowercase();
            if lowered.contains("unavailable") || lowered.contains("unsupported") {
                view.history.mark_unsupported();
            }
            view.push(&format!("Error: {error}"));
            true
        }
        Applied::Stale => false,
    }
}

/// 历史恢复只写未提交草稿；附件由 `DraftAttachments::from_history` 依据正文占位符重建。
pub(crate) fn restore(view: &mut View, draft: Draft) {
    view.editor.replace_all(&draft.text);
    view.draft_attachments = draft.attachments;
    view.sync_completion();
}
