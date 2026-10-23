//! 历史恢复的跨层契约：启动 pinned 项不被复制、不可证明项跳过、合并超限保留原草稿。
use crate::draft_attachments::DraftAttachments;
use crate::input_history::*;
use crate::input_history_tests::{draft_attachments, entry};
use serde_json::{Value, json};
use zcode_cli_core_api::RuntimeError;

#[test]
fn startup_pinned_attachments_survive_history_edits_without_being_doubled_on_down() {
    use crate::draft_attachments::AttachmentSource;

    fn startups(attachments: &DraftAttachments) -> usize {
        attachments
            .items()
            .iter()
            .filter(|item| item.source == AttachmentSource::Startup)
            .count()
    }

    let mut history = History::default();
    let pinned = draft_attachments();
    assert!(matches!(
        history.recall_up("s", 1, "live draft", &pinned),
        Step::Request(0)
    ));
    let Applied::Restore(draft) = history.apply(
        "s",
        1,
        0,
        Ok(entry(
            "older look @a.txt",
            json!([{"type": "file", "path": "a.txt"}]),
        )),
        "/ws",
    ) else {
        panic!("valid reply must restore");
    };
    // 历史项只有 inline @a.txt；启动 pinned 项并入同一份草稿，仍是唯一 owner。
    assert_eq!(startups(&draft.attachments), 1);
    assert_eq!(draft.attachments.refs_for_text(&draft.text).len(), 2);

    // 用户编辑恢复出来的历史草稿，再 ↑：启动附件不能丢，也不能叠加成两份。
    let edited = draft.clone();
    history.edited();
    assert!(matches!(
        history.recall_up("s", 1, "older edited", &edited.attachments),
        Step::Request(0)
    ));
    let Applied::Restore(again) =
        history.apply("s", 1, 0, Ok(entry("older still", Value::Null)), "/ws")
    else {
        panic!("reply must restore");
    };
    assert_eq!(startups(&again.attachments), 1);
    assert_eq!(again.attachments.refs_for_text(&again.text).len(), 1);

    // ↓ 回原草稿：启动附件只有一份（被接受后由 clear 收尾，不是这里重复追加）。
    let Step::Restore(original) = history.recall_down("s", 1) else {
        panic!("down must restore the saved draft");
    };
    assert_eq!(startups(&original.attachments), 1);
    assert_eq!(original.attachments, edited.attachments);
}

#[test]
fn history_pinned_items_are_not_carried_into_later_drafts_as_startup() {
    use crate::draft_attachments::AttachmentSource;

    let mut history = History::default();
    let empty = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "", &empty),
        Step::Request(0)
    ));
    // 历史里的 pinned 项（启动 --attach 的记录）只是历史来源，不是当前启动项。
    let Applied::Restore(draft) = history.apply(
        "s",
        1,
        0,
        Ok(entry(
            "x",
            json!([{"type": "pdf", "path": "/tmp/report.pdf"}]),
        )),
        "/ws",
    ) else {
        panic!("pinned history item must restore");
    };
    assert_eq!(
        draft.attachments.items()[0].source,
        AttachmentSource::History
    );
    history.edited();
    assert!(matches!(
        history.recall_up("s", 1, "next", &draft.attachments),
        Step::Request(0)
    ));
    let Applied::Restore(next) =
        history.apply("s", 1, 0, Ok(entry("next older", Value::Null)), "/ws")
    else {
        panic!("reply must restore");
    };
    assert!(
        next.attachments.is_empty(),
        "历史 pinned 不能被误带成新草稿的启动附件"
    );
}

#[test]
fn an_unrecoverable_entry_is_skipped_on_the_next_up_and_down_returns_to_the_layer() {
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
    // skip 1 是 artifact/content：保留原草稿并明确提示。
    assert!(matches!(
        history.recall_up("s", 1, "newer", &attachments),
        Step::Request(1)
    ));
    let artifact = json!([{"type": "artifact", "path": "zcode-artifact://s/x"}]);
    assert!(matches!(
        history.apply("s", 1, 1, Ok(entry("art", artifact)), "/ws"),
        Applied::Failed(_)
    ));
    // 游标没推进，但下一次 ↑ 跳过坏项继续向上。
    assert!(matches!(
        history.recall_up("s", 1, "newer", &attachments),
        Step::Request(2)
    ));
    assert!(matches!(
        history.apply("s", 1, 2, Ok(entry("older", Value::Null)), "/ws"),
        Applied::Restore(_)
    ));
    // 迟到/重复回包不破坏游标。
    assert!(matches!(
        history.apply("s", 1, 0, Ok(entry("dupe", Value::Null)), "/ws"),
        Applied::Stale
    ));
    // ↓ 按正常上一层走，不再跳过任何位置。
    assert!(matches!(history.recall_down("s", 1), Step::Request(1)));
}

#[test]
fn a_backend_query_error_is_not_skipped_over_and_the_end_stops_the_cursor() {
    let mut history = History::default();
    let attachments = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::Request(0)
    ));
    let unavailable = RuntimeError::MethodNotFound("Input history unavailable".into());
    assert!(matches!(
        history.apply("s", 1, 0, Err(unavailable), "/ws"),
        Applied::Failed(_)
    ));
    // 网络/未实现错误不能盲跳：仍请求同一位置，不掩盖失败。
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::Request(0)
    ));
    // 失败后跳到空历史边界：结束而不是继续跳过。
    assert!(matches!(
        history.apply("s", 1, 0, Ok(Value::Null), "/ws"),
        Applied::End
    ));
    assert!(matches!(
        history.recall_up("s", 1, "draft", &attachments),
        Step::AtStart
    ));
}

#[test]
fn merging_startup_attachments_over_the_cap_keeps_the_draft_and_the_cursor() {
    let many = (0..16)
        .map(|index| {
            json!({
                "ref": format!("/ws/f{index}.txt"),
                "fileName": format!("f{index}.txt"),
                "mime": "text/plain",
                "bytes": 1
            })
        })
        .collect::<Vec<_>>();
    let saved = DraftAttachments::from_startup(many).unwrap();
    let mut history = History::default();
    assert!(matches!(
        history.recall_up("s", 1, "draft", &saved),
        Step::Request(0)
    ));
    assert!(matches!(
        history.apply(
            "s",
            1,
            0,
            Ok(entry("@a.txt", json!([{"type": "file", "path": "a.txt"}]))),
            "/ws",
        ),
        Applied::Failed(_)
    ));
    // 合并失败不推进 offset（仍在草稿位置），但下一次 ↑ 继续向上而不是卡住。
    assert!(matches!(
        history.recall_up("s", 1, "draft", &saved),
        Step::Request(1)
    ));
    history.request_failed();
    assert!(matches!(history.recall_down("s", 1), Step::Ignore));
}

#[test]
fn down_skips_an_unrecoverable_newer_entry_and_then_restores_the_saved_draft() {
    use crate::draft_attachments::AttachmentSource;

    fn startups(attachments: &DraftAttachments) -> usize {
        attachments
            .items()
            .iter()
            .filter(|item| item.source == AttachmentSource::Startup)
            .count()
    }

    let mut history = History::default();
    let pinned = draft_attachments();
    assert!(matches!(
        history.recall_up("s", 1, "live draft", &pinned),
        Step::Request(0)
    ));
    // ↑ skip 0 是不可恢复 artifact：保留原草稿，下一次 ↑ 跳过它。
    let artifact = json!([{"type": "artifact", "path": "zcode-artifact://s/x"}]);
    assert!(matches!(
        history.apply("s", 1, 0, Ok(entry("art", artifact.clone())), "/ws"),
        Applied::Failed(_)
    ));
    assert!(matches!(
        history.recall_up("s", 1, "live draft", &pinned),
        Step::Request(1)
    ));
    let Applied::Restore(older) = history.apply(
        "s",
        1,
        1,
        Ok(entry(
            "older look @a.txt",
            json!([{"type": "file", "path": "a.txt"}]),
        )),
        "/ws",
    ) else {
        panic!("valid older entry must restore");
    };
    // ↓ 回 skip 0 仍失败：失败位置记在 ↓ 方向，不能反复请求 0。
    assert!(matches!(history.recall_down("s", 1), Step::Request(0)));
    assert!(matches!(
        history.apply("s", 1, 0, Ok(entry("art", artifact)), "/ws"),
        Applied::Failed(_)
    ));
    // 失败回包已被消费，不会自动补发读取请求。
    assert!(matches!(
        history.apply("s", 1, 0, Ok(entry("dupe", Value::Null)), "/ws"),
        Applied::Stale
    ));
    // 再次 ↓：failed_skip == 0，直接恢复首次保存的正文与附件，且启动项只有一份。
    let Step::Restore(original) = history.recall_down("s", 1) else {
        panic!("down must restore the saved draft after skipping the bad newer item");
    };
    assert_eq!(original.text, "live draft");
    assert_eq!(original.attachments, pinned);
    assert_eq!(startups(&original.attachments), 1);
    assert_eq!(startups(&older.attachments), 1);
    // 已回到实时草稿：offset 已清空，后续 ↓ 不再发请求。
    assert!(matches!(history.recall_down("s", 1), Step::Ignore));
}

#[test]
fn consecutive_unrecoverable_newer_entries_are_skipped_until_the_saved_draft() {
    let mut history = History::default();
    let empty = DraftAttachments::default();
    for (skip, text) in [(0, "newest"), (1, "one"), (2, "two"), (3, "three")] {
        assert!(matches!(
            history.recall_up("s", 1, "draft", &empty),
            Step::Request(expected) if expected == skip
        ));
        assert!(matches!(
            history.apply("s", 1, skip, Ok(entry(text, Value::Null)), "/ws"),
            Applied::Restore(_)
        ));
    }
    let artifact = json!([{"type": "artifact", "path": "zcode-artifact://s/x"}]);
    // offset == 3，依次尝试 2/1/0 三个坏项；每次 ↓ 只发一张票据。
    for (expected, bad) in [(2, "two"), (1, "one"), (0, "newest")] {
        assert!(matches!(
            history.recall_down("s", 1),
            Step::Request(skip) if skip == expected
        ));
        assert!(matches!(
            history.apply("s", 1, expected, Ok(entry(bad, artifact.clone())), "/ws"),
            Applied::Failed(_)
        ));
    }
    // 三个坏项都跳过后，↓ 退出到保存的原草稿。
    let Step::Restore(original) = history.recall_down("s", 1) else {
        panic!("down must exit through consecutive unrecoverable newer entries");
    };
    assert_eq!(original.text, "draft");
    assert!(matches!(history.recall_down("s", 1), Step::Ignore));
}

#[test]
fn a_backend_error_on_down_does_not_set_failed_skip() {
    let mut history = History::default();
    let empty = DraftAttachments::default();
    assert!(matches!(
        history.recall_up("s", 1, "draft", &empty),
        Step::Request(0)
    ));
    assert!(matches!(
        history.apply("s", 1, 0, Ok(entry("newest", Value::Null)), "/ws"),
        Applied::Restore(_)
    ));
    assert!(matches!(
        history.recall_up("s", 1, "newest", &empty),
        Step::Request(1)
    ));
    assert!(matches!(
        history.apply("s", 1, 1, Ok(entry("older", Value::Null)), "/ws"),
        Applied::Restore(_)
    ));
    assert!(matches!(history.recall_down("s", 1), Step::Request(0)));
    let unavailable = RuntimeError::MethodNotFound("Input history unavailable".into());
    assert!(matches!(
        history.apply("s", 1, 0, Err(unavailable), "/ws"),
        Applied::Failed(_)
    ));
    // 后端错误不写 failed_skip：下一次 ↓ 仍请求同一位置，不能靠盲跳掩盖错误。
    assert!(matches!(history.recall_down("s", 1), Step::Request(0)));
}
