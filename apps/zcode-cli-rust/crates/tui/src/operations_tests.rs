//! 非阻塞 operation 状态机回归：单飞、draft 唯一 owner、拒绝草稿槽与世代失效。
use crate::draft_attachments::DraftAttachments;
use crate::operations::{Attribution, BeginError, OpKind, Operations, RejectedDraft, SentDraft};
use serde_json::json;

fn draft(text: &str) -> SentDraft {
    SentDraft::new(
        text,
        DraftAttachments::from_startup(vec![json!({
            "ref": "/ws/a.txt", "fileName": "a.txt", "mime": "text/plain", "bytes": 0
        })])
        .unwrap(),
    )
}

fn ops_with_inflight() -> Operations {
    let mut ops = Operations::default();
    assert!(
        ops.begin(OpKind::Submit, "s1", 3, Some(draft("hello")))
            .is_ok()
    );
    ops
}

#[test]
fn second_mutation_is_rejected_while_one_is_in_flight() {
    let mut ops = ops_with_inflight();
    // 仍有 mutation 在飞时再 Enter：明确拒绝，不重复 admission，也不在前端排队。
    assert_eq!(
        ops.begin(OpKind::Submit, "s1", 3, Some(draft("second"))),
        Err(BeginError::Busy)
    );
    assert_eq!(ops.inflight_kind(), Some(OpKind::Submit));
    assert_eq!(ops.inflight_draft().unwrap().text, "hello");
}

#[test]
fn accepted_ack_only_settles_the_sent_draft_never_the_live_editor() {
    let mut ops = ops_with_inflight();
    // 等待 ACK 期间用户输入的新正文/附件在 View 里；operation 只持有已发送那份。
    let live_editor = "new words typed while waiting";
    assert_eq!(
        ops.accepted("s1", 3, OpKind::Submit, None),
        Attribution::Match
    );
    assert!(!ops.busy());
    assert_eq!(live_editor, "new words typed while waiting");
    // 结算后再提交时用新草稿，旧 draft 不能被复用。
    assert!(
        ops.begin(OpKind::Submit, "s1", 3, Some(draft(live_editor)))
            .is_ok()
    );
    assert_eq!(ops.inflight_draft().unwrap().text, live_editor);
}

#[test]
fn rejected_draft_keeps_one_restorable_copy_and_blocks_a_second_rejection() {
    let mut ops = ops_with_inflight();
    let (attribution, stored) = ops.rejected("s1", 3, OpKind::Submit, None);
    assert_eq!(attribution, Attribution::Match);
    assert!(stored);
    assert!(ops.has_rejected());
    // 未处理拒绝草稿时禁止再产生下一份：新 mutation 被拦，提示恢复/编辑后再提交。
    assert_eq!(
        ops.begin(OpKind::Submit, "s1", 3, Some(draft("next"))),
        Err(BeginError::RejectedPending)
    );
    // 只读/stop 不受拒绝草稿限制。
    assert!(ops.begin(OpKind::Stop, "s1", 3, None).is_ok());
}

#[test]
fn ctrl_y_swaps_main_editor_and_rejected_draft_without_concatenating() {
    let mut ops = ops_with_inflight();
    ops.rejected("s1", 3, OpKind::Submit, None);
    let swapped = ops
        .swap_rejected("s1", 4, draft("fresh draft"))
        .expect("same session must restore");
    let restored = swapped.restored;
    assert_eq!(restored.text, "hello");
    assert_eq!(restored.attachments.len(), 1);
    assert!(!swapped.unknown_outcome);
    // 交换而不是拼接：新草稿完整进入拒绝槽，等下一次显式交换。
    let kept = swapped.kept.expect("非空 current 必须留在 alternate");
    assert_eq!(kept.text, "fresh draft");
    assert_eq!(kept.attachments.len(), 1);
    let back = ops.swap_rejected("s1", 4, restored).unwrap();
    assert_eq!(back.restored.text, "fresh draft");
}

#[test]
fn swapping_in_an_empty_editor_clears_the_alternate_and_unblocks_admission() {
    let mut ops = ops_with_inflight();
    ops.rejected("s1", 3, OpKind::Submit, None);
    // 用户清空当前 editor 再 Ctrl-Y：恢复旧稿，alternate 为空必须清槽。
    let swapped = ops
        .swap_rejected("s1", 4, SentDraft::default())
        .expect("same session must restore");
    assert_eq!(swapped.restored.text, "hello");
    assert!(swapped.kept.is_none());
    assert!(!ops.has_rejected(), "空 alternate 不能永久阻塞提交");
    assert_eq!(ops.alternate_len(), 0);
    // 恢复后可以正常提交这份恢复稿。
    assert!(
        ops.begin(OpKind::Submit, "s1", 4, Some(swapped.restored))
            .is_ok()
    );
}

#[test]
fn ctrl_shift_y_discards_the_alternate_explicitly_and_unblocks_admission() {
    let mut ops = ops_with_inflight();
    ops.rejected("s1", 3, OpKind::Submit, None);
    ops.swap_rejected("s1", 4, draft("fresh draft")).unwrap();
    // 交换后 alternate 里是用户新草稿：只有显式 discard 才允许丢稿。
    assert_eq!(
        ops.begin(OpKind::Submit, "s1", 4, Some(draft("third"))),
        Err(BeginError::RejectedPending)
    );
    assert!(ops.discard_rejected("s1").is_some());
    assert!(!ops.has_rejected());
    assert_eq!(ops.alternate_len(), 0);
    assert!(
        ops.begin(OpKind::Submit, "s1", 4, Some(draft("third")))
            .is_ok()
    );
}

#[test]
fn generation_change_keeps_the_unknown_outcome_draft_for_explicit_recovery() {
    let mut ops = ops_with_inflight();
    // 已发送但结果未知：不能丢数据、不能当未接受自动恢复，也不能跨会话重发。
    assert!(ops.invalidate(9).is_none());
    assert!(ops.has_rejected());
    assert_eq!(ops.inflight_kind(), None);
    assert_eq!(
        ops.begin(OpKind::Submit, "s9", 9, Some(draft("next"))),
        Err(BeginError::RejectedPending)
    );
    let swapped = ops
        .swap_rejected("s1", 9, SentDraft::default())
        .expect("旧 session 标签允许同会话显式恢复");
    assert_eq!(swapped.restored.text, "hello");
    assert!(swapped.unknown_outcome, "结果未知必须提示复核");
    // 跨会话仍不自动恢复。
    let mut ops = ops_with_inflight();
    ops.invalidate(9);
    assert!(ops.swap_rejected("s9", 9, SentDraft::default()).is_none());
}

#[test]
fn rejected_draft_from_another_session_is_not_restored_silently() {
    let mut ops = ops_with_inflight();
    ops.rejected("s1", 3, OpKind::Submit, None);
    // 切到别的会话后 Ctrl-Y：不跨会话偷偷重发，必须由调用方提示。
    assert!(ops.swap_rejected("s2", 5, draft("elsewhere")).is_none());
    assert!(ops.has_rejected());
}

#[test]
fn stale_generation_and_epoch_never_settle_the_new_operation() {
    let mut ops = ops_with_inflight();
    // 旧 generation 的回包不得结算当前（同 session 新世代）operation。
    assert_eq!(
        ops.accepted("s1", 2, OpKind::Submit, None),
        Attribution::Stale
    );
    assert!(ops.busy());
    // 同 generation 但旧意图 epoch 同样失效。
    assert_eq!(
        ops.accepted("s1", 3, OpKind::Submit, Some(0)),
        Attribution::Stale
    );
    assert_eq!(
        ops.accepted("s1", 3, OpKind::Submit, Some(ops.epoch())),
        Attribution::Match
    );
}

#[test]
fn topic_closed_invalidates_inflight_ticket_without_losing_the_sent_draft() {
    let mut ops = ops_with_inflight();
    // 已发送但结果未知：票据失效，但那份正文必须以旧 owner 标签保留，等待显式恢复。
    assert!(ops.invalidate(4).is_none());
    assert!(!ops.busy());
    assert!(ops.has_rejected());
    assert_eq!(ops.alternate_len(), 1);
}

#[test]
fn ctrl_c_shows_intent_immediately_and_queues_one_stop_behind_the_slot() {
    let mut ops = ops_with_inflight();
    // 慢 ACK 下先显示“停止请求待处理”，不伪造 cancelled。
    assert!(!ops.request_stop(false));
    assert!(ops.stop_pending());
    // 重复 Ctrl-C 不再产生第二份 stop 意图。
    assert!(!ops.request_stop(false));
    assert!(!ops.take_queued_stop());
    // slot 结算后只发唯一 stop。
    ops.accepted("s1", 3, OpKind::Submit, None);
    assert!(ops.take_queued_stop());
    assert!(!ops.take_queued_stop());
}

#[test]
fn stop_with_empty_slot_dispatches_immediately_and_does_not_carry_a_draft() {
    let mut ops = Operations::default();
    assert!(ops.request_stop(false));
    assert!(ops.stop_pending());
    assert!(ops.begin(OpKind::Stop, "s1", 0, Some(draft("x"))).is_ok());
    assert!(ops.inflight_draft().is_none());
    assert_eq!(
        ops.accepted("s1", 0, OpKind::Stop, None),
        Attribution::Match
    );
    assert!(!ops.stop_pending());
}

/// Ctrl-Y/`/draft swap` 没有可恢复草稿时，不能先 take 当前附件再只提示。
#[test]
fn swap_without_alternate_keeps_the_current_editor_and_attachments() {
    let mut view = crate::frontend_test_support::view();
    view.editor.replace_all("current text");
    view.draft_attachments = crate::frontend_test_support::draft_with("/ws/a.txt", 3);
    crate::frontend_operations::swap_alternate(&mut view, false);
    assert_eq!(view.editor.text(), "current text");
    assert_eq!(
        view.draft_attachments.items().len(),
        1,
        "无可恢复草稿时附件不得丢失"
    );
    assert!(
        view.notices
            .last()
            .is_some_and(|note| note.contains("kept")),
        "{:?}",
        view.notices.last()
    );
}

/// alternate 属于别的会话时同样失败：当前正文与附件必须原样保留。
#[test]
fn swap_from_another_session_keeps_current_attachments() {
    let mut ops = Operations::default();
    assert!(
        ops.begin(OpKind::Submit, "other", 3, Some(draft("other draft")))
            .is_ok()
    );
    let _ = ops.rejected("other", 3, OpKind::Submit, None);
    let mut view = crate::frontend_test_support::view();
    view.editor.replace_all("current text");
    view.draft_attachments = crate::frontend_test_support::draft_with("/ws/a.txt", 3);
    view.operations = ops;
    crate::frontend_operations::swap_alternate(&mut view, false);
    assert_eq!(view.editor.text(), "current text");
    assert_eq!(view.draft_attachments.items().len(), 1);
}

/// 显式丢弃是用户主动删除，旧会话草稿也必须能清空，否则新会话永久被恢复槽阻塞。
#[test]
fn explicit_discard_clears_a_draft_from_another_session_without_deadlock() {
    let mut ops = ops_with_inflight();
    ops.rejected("s1", 3, OpKind::Submit, None);
    assert!(ops.recoverable("s2").is_none(), "跨会话不允许交换");
    assert!(ops.discard_rejected("s2").is_some());
    assert!(!ops.has_rejected());
    assert!(ops.recoverable("s2").is_none());
}

/// 恢复槽已占用时 `rejected` 不能先 take 再返回 false：草稿与附件仍在 inflight。
#[test]
fn rejection_with_full_alternate_slot_keeps_the_inflight_draft_and_bytes() {
    let mut ops = Operations::default();
    ops.rejected = Some(RejectedDraft {
        draft: draft("older rejected"),
        session: "s1".into(),
        generation: 3,
    });
    ops.force_inflight_for_test(OpKind::Submit, "s1", 3, draft("new payload"));
    let (attribution, stored) = ops.rejected("s1", 3, OpKind::Submit, None);
    assert_eq!(attribution, Attribution::Match);
    assert!(!stored, "满槽不能声称已存储");
    assert!(ops.busy(), "原 inflight 必须保留，不能先 take 丢稿");
    assert_eq!(ops.inflight_draft().unwrap().text, "new payload");
    assert_eq!(ops.inflight_draft().unwrap().attachments.len(), 1);
    // 调用方显式拿回时字节与附件完整。
    let returned = ops.abort().expect("caller takes the failed draft back");
    assert_eq!(returned.text, "new payload");
    assert_eq!(returned.attachments.len(), 1);
}

/// unknown 标签跟随草稿本身：交换不会把“结果未知”洗成 known，也不会贴到新草稿上。
#[test]
fn unknown_outcome_follows_the_draft_across_repeated_swaps() {
    let mut ops = ops_with_inflight();
    ops.invalidate(9);
    let first = ops
        .swap_rejected("s1", 9, SentDraft::new("fresh", Default::default()))
        .unwrap();
    assert!(first.unknown_outcome, "unknown 草稿交换时必须提示复核");
    assert_eq!(first.restored.text, "hello");
    assert_eq!(first.restored.attachments.len(), 1);
    assert!(!ops.has_unknown(), "新草稿不能被贴上 unknown 标签");
    let second = ops.swap_rejected("s1", 9, first.restored).unwrap();
    assert!(!second.unknown_outcome, "交换回来的是用户新草稿");
    assert_eq!(second.restored.text, "fresh");
    assert!(ops.has_unknown(), "旧发送稿仍保留 unknown 元数据");
    assert_eq!(second.kept.as_ref().unwrap().attachments.len(), 1);
    let third = ops.swap_rejected("s1", 9, second.restored).unwrap();
    assert!(third.unknown_outcome);
    assert_eq!(third.restored.text, "hello");
    assert_eq!(third.restored.attachments.len(), 1);
}
