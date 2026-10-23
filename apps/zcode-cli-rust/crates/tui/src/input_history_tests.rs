//! 历史游标的纯本地契约：请求去重、迟到丢弃、越界不丢草稿、附件往返恢复。
use crate::draft_attachments::DraftAttachments;
use crate::input_history::*;
use serde_json::{Value, json};
use zcode_cli_core_api::RuntimeError;

pub(super) fn draft_attachments() -> DraftAttachments {
    DraftAttachments::from_startup(vec![json!({
        "ref": "/ws/report.pdf", "fileName": "report.pdf",
        "mime": "application/pdf", "bytes": 0
    })])
    .unwrap()
}

pub(super) fn entry(text: &str, attachments: Value) -> Value {
    json!({"id": "h", "kind": "prompt", "text": text, "attachments": attachments})
}

#[test]
fn up_saves_the_live_draft_and_never_sends_twice_while_pending() {
    let mut history = History::default();
    let attachments = draft_attachments();
    match history.recall_up("s", 1, "live draft", &attachments) {
        Step::Request(0) => {}
        other => panic!("first up must request skip 0: {other:?}"),
    }
    // 请求中再次按 ↑：不多发一张票据。
    assert!(matches!(
        history.recall_up("s", 1, "changed meanwhile", &attachments),
        Step::Ignore
    ));
}

#[test]
fn a_failed_request_releases_the_cursor_for_retry() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "", &attachments),
        Step::Request(0)
    ));
    history.request_failed();
    assert!(matches!(
        history.recall_up("s", 1, "", &attachments),
        Step::Request(0)
    ));
}

#[test]
fn reply_restores_text_and_attachments_and_down_restores_the_original_draft() {
    let mut history = History::default();
    let pinned = draft_attachments();
    assert!(matches!(
        history.recall_up("s", 1, "live draft", &pinned),
        Step::Request(0)
    ));
    let restored = history.apply(
        "s",
        1,
        0,
        Ok(entry(
            "older look @a.txt",
            json!([{"type": "file", "path": "a.txt"}]),
        )),
        "/ws",
    );
    let Applied::Restore(draft) = restored else {
        panic!("valid reply must restore: {restored:?}");
    };
    assert_eq!(draft.text, "older look @a.txt");
    // inline @a.txt + 从原草稿带过来的启动 pinned：启动附件不因浏览历史而丢失。
    assert_eq!(draft.attachments.refs_for_text(&draft.text).len(), 2);
    assert_eq!(
        draft.attachments.items()[0].placeholder.as_deref(),
        Some("@a.txt")
    );

    // ↓ 到最新之后：恢复首次保存的正文与 pinned 附件，且不再发请求。
    let Step::Restore(original) = history.recall_down("s", 1) else {
        panic!("down past the newest entry restores the saved draft");
    };
    assert_eq!(original.text, "live draft");
    assert_eq!(original.attachments, pinned);
}

#[test]
fn editing_invalidates_a_late_reply_and_keeps_the_new_draft() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "", &attachments),
        Step::Request(0)
    ));
    history.edited();
    assert!(matches!(
        history.apply("s", 1, 0, Ok(entry("old", Value::Null)), "/ws"),
        Applied::Stale
    ));
    // 旧回包被丢弃后仍可重新召回。
    assert!(matches!(
        history.recall_up("s", 1, "new text", &attachments),
        Step::Request(0)
    ));
}

#[test]
fn null_and_errors_do_not_advance_the_cursor_or_forget_the_draft() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::Request(0)
    ));
    assert!(matches!(
        history.apply("s", 1, 0, Ok(Value::Null), "/ws"),
        Applied::End
    ));
    // 越界后不重复请求同一个位置，也不丢草稿。
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::AtStart
    ));
    assert!(matches!(history.recall_down("s", 1), Step::Ignore));

    let mut failing = History::default();
    assert!(matches!(
        failing.recall_up("s", 1, "draft", &attachments),
        Step::Request(0)
    ));
    let error = RuntimeError::MethodNotFound("Input history unavailable".into());
    assert!(matches!(
        failing.apply("s", 1, 0, Err(error), "/ws"),
        Applied::Failed(_)
    ));
    failing.mark_unsupported();
    assert!(matches!(
        failing.recall_up("s", 1, "draft", &attachments),
        Step::Unavailable
    ));
}

#[test]
fn unpreservable_history_attachments_fail_instead_of_dropping_items() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::Request(0)
    ));
    let applied = history.apply(
        "s",
        1,
        0,
        Ok(entry(
            "art @x",
            json!([{"type": "image", "content": "data:image/png;base64,AAAA"}]),
        )),
        "/ws",
    );
    assert!(matches!(applied, Applied::Failed(_)));
    // 失败不推进游标，但下一次 ↑ 跳过不可恢复的这一项继续向上。
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::Request(1)
    ));
    // 游标仍在草稿位置；↓ 清掉 failed 游标后回到正常一层。
    history.request_failed();
    assert!(matches!(history.recall_down("s", 1), Step::Ignore));
}

#[test]
fn session_and_generation_changes_invalidate_tickets_and_cursor() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "", &attachments),
        Step::Request(0)
    ));
    // 同 id 新 generation：旧回包丢弃。
    assert!(matches!(
        history.apply("s", 2, 0, Ok(entry("old", Value::Null)), "/ws"),
        Applied::Stale
    ));
    // 新 generation 重新召回从 skip 0 开始。
    assert!(matches!(
        history.recall_up("s", 2, "", &attachments),
        Step::Request(0)
    ));
    // 切 session。
    assert!(matches!(
        history.apply("other", 2, 0, Ok(entry("old", Value::Null)), "/ws"),
        Applied::Stale
    ));
}

#[test]
fn down_from_an_older_entry_requests_the_newer_one() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::Request(0)
    ));
    assert!(matches!(
        history.apply("s", 1, 0, Ok(entry("newer", Value::Null)), "/ws"),
        Applied::Restore(_)
    ));
    assert!(matches!(
        history.recall_up("s", 1, "newer", &attachments),
        Step::Request(1)
    ));
    assert!(matches!(
        history.apply("s", 1, 1, Ok(entry("older", Value::Null)), "/ws"),
        Applied::Restore(_)
    ));
    assert!(matches!(history.recall_down("s", 1), Step::Request(0)));
}

#[test]
fn editing_while_pending_forgets_the_old_saved_draft_and_restores_the_new_one() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    // 第一次 ↑ 在 offset 仍为 None 时保存了旧草稿。
    assert!(matches!(
        history.recall_up("s", 1, "old draft", &attachments),
        Step::Request(0)
    ));
    // 真实编辑取消这次 pending：旧草稿不能再被当成“首次草稿”。
    history.edited();
    assert!(matches!(
        history.recall_up("s", 1, "new draft", &attachments),
        Step::Request(0)
    ));
    assert!(matches!(
        history.apply("s", 1, 0, Ok(entry("older", Value::Null)), "/ws"),
        Applied::Restore(_)
    ));
    let Step::Restore(original) = history.recall_down("s", 1) else {
        panic!("down must restore the draft saved after the edit");
    };
    assert_eq!(original.text, "new draft");
}

#[test]
fn an_accepted_prompt_after_an_exhausted_null_reopens_the_same_skip() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::Request(0)
    ));
    assert!(matches!(
        history.apply("s", 1, 0, Ok(Value::Null), "/ws"),
        Applied::End
    ));
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::AtStart
    ));
    // 新 prompt 被 actor 接受后，历史可能已有这一项：不能永远停在 AtStart。
    history.edited();
    assert!(matches!(
        history.recall_up("s", 1, "fresh prompt", &attachments),
        Step::Request(0)
    ));
}
