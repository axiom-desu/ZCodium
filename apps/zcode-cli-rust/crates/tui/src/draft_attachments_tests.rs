//! 草稿附件：严格 wire 形态、占位符边界、16 上限、启动项去重与历史恢复。
use super::*;
use serde_json::json;
use zcode_cli_protocol::AttachmentRef;

pub(super) fn entry(path: &str, bytes: u64) -> Entry {
    let name = path.rsplit('/').next().unwrap_or(path).to_owned();
    Entry {
        path: path.to_owned(),
        mime: workspace_paths::mime_for(&name).to_owned(),
        name,
        directory: false,
        bytes,
    }
}

pub(super) fn draft_with(placeholder: &str) -> DraftAttachments {
    let mut drafts = DraftAttachments::default();
    drafts.attach_entry(&entry(placeholder.trim_start_matches('@'), 7));
    drafts
}

pub(super) fn startup(value: Value) -> Result<DraftAttachments> {
    DraftAttachments::from_startup(vec![value])
}

pub(super) fn message(error: anyhow::Error) -> String {
    format!("{error:#}")
}

#[test]
fn refs_are_strict_attachment_refs_with_real_bytes() {
    let mut drafts = DraftAttachments::default();
    assert_eq!(
        drafts.attach_entry(&entry("src/main.rs", 42)),
        AttachResult::Added
    );
    let refs = drafts.refs_for_text("look @src/main.rs please");
    assert_eq!(refs.len(), 1);
    let object = refs[0].as_object().unwrap();
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(keys, ["bytes", "fileName", "mime", "ref"]);
    let parsed: AttachmentRef = serde_json::from_value(refs[0].clone()).unwrap();
    assert_eq!(parsed.r#ref, "src/main.rs");
    assert_eq!(parsed.file_name, "main.rs");
    assert_eq!(parsed.mime, "text/plain");
    assert_eq!(parsed.bytes, 42);
    assert_eq!(parsed.preview_ref, None);
}

#[test]
fn deleted_placeholders_are_not_sent_but_pinned_items_survive() {
    let mut drafts = draft_with("@a.txt");
    assert_eq!(drafts.refs_for_text("@a.txt then text").len(), 1);
    // 用户手动删除占位符：附件不发送。
    assert!(drafts.refs_for_text("no mention left").is_empty());
    drafts.retain_for_text("no mention left");
    assert!(drafts.is_empty());
    // 启动 pinned 项没有占位符，始终带上，直到显式 clear。
    let mut pinned = DraftAttachments::from_startup(vec![json!({
        "ref": "/tmp/report.pdf", "fileName": "report.pdf",
        "mime": "application/pdf", "bytes": 0
    })])
    .unwrap();
    pinned.retain_for_text("plain text without mentions");
    assert_eq!(pinned.refs_for_text("").len(), 1);
    pinned.clear();
    assert!(pinned.refs_for_text("").is_empty());
}

#[test]
fn placeholder_matching_respects_token_boundaries() {
    let drafts = draft_with("@a");
    // `@a` 不能从 `@ab` 里被错误地拆出来发送。
    assert!(drafts.refs_for_text("@ab").is_empty());
    assert!(drafts.refs_for_text("mail@a").is_empty());
    assert_eq!(drafts.refs_for_text("x @a y").len(), 1);
    assert_eq!(drafts.refs_for_text("@a").len(), 1);
}

#[test]
fn attachments_dedupe_and_stop_at_sixteen() {
    let mut drafts = DraftAttachments::default();
    assert_eq!(drafts.attach_entry(&entry("a.txt", 1)), AttachResult::Added);
    assert_eq!(
        drafts.attach_entry(&entry("a.txt", 1)),
        AttachResult::Duplicate
    );
    let mut text = String::from("@a.txt");
    for index in 1..16 {
        let path = format!("f{index}.txt");
        assert_eq!(drafts.attach_entry(&entry(&path, 1)), AttachResult::Added);
        text.push(' ');
        text.push_str(&format!("@{path}"));
    }
    assert_eq!(drafts.len(), 16);
    assert_eq!(drafts.refs_for_text(&text).len(), 16);
    // 第 17 个不静默丢：返回 Full 由前端提示，正文仍保留。
    assert_eq!(
        drafts.attach_entry(&entry("overflow.txt", 1)),
        AttachResult::Full
    );
    assert_eq!(drafts.len(), 16);
}

#[test]
fn startup_values_require_the_strict_wire_shape() {
    let ok = startup(json!({
        "ref": "/tmp/a.md", "fileName": "a.md", "mime": "text/markdown", "bytes": 3
    }))
    .unwrap();
    assert_eq!(ok.len(), 1);
    assert_eq!(ok.items()[0].placeholder, None, "启动项是 pinned");
    assert_eq!(ok.items()[0].bytes, 3);
    assert_eq!(ok.refs_for_text("").len(), 1);
    // 可选 previewRef 合法；大写 MIME 归一化。
    let preview = startup(json!({
        "ref": "/tmp/b.png", "fileName": "b.png", "mime": "IMAGE/PNG",
        "bytes": 9, "previewRef": "/tmp/b.preview.png"
    }))
    .unwrap();
    assert_eq!(preview.items()[0].mime, "image/png");

    // 非法/缺字段一律 Err，不再 continue 静默丢项。
    for invalid in [
        json!("not-an-object"),
        json!(null),
        json!({"fileName": "a.md", "mime": "text/markdown", "bytes": 1}),
        json!({"ref": "", "fileName": "a.md", "mime": "text/markdown", "bytes": 1}),
        json!({"ref": "/tmp/a.md", "mime": "text/markdown", "bytes": 1}),
        json!({"ref": "/tmp/a.md", "fileName": "", "mime": "text/markdown", "bytes": 1}),
        json!({"ref": "/tmp/a.md", "fileName": "a.md", "bytes": 1}),
        json!({"ref": "/tmp/a.md", "fileName": "a.md", "mime": "not-a-mime", "bytes": 1}),
        json!({"ref": "/tmp/a.md", "fileName": "a.md", "mime": "text/markdown"}),
        json!({"ref": "/tmp/a.md", "fileName": "a.md", "mime": "text/markdown", "bytes": -1}),
        json!({"ref": "/tmp/a.md", "fileName": "a.md", "mime": "text/markdown", "bytes": 1,
               "artifactRef": "zcode-artifact://s/x"}),
        json!({"ref": "/tmp/a\u{1}.md", "fileName": "a.md", "mime": "text/markdown", "bytes": 1}),
        json!({"ref": "/tmp/a.md", "fileName": "a\u{7}.md", "mime": "text/markdown", "bytes": 1}),
    ] {
        assert!(
            DraftAttachments::from_startup(vec![invalid.clone()]).is_err(),
            "invalid startup attachment must be rejected: {invalid}"
        );
    }
    // 合法项 + 非法项：整批 Err，调用方保留原草稿，不会悄悄少一个。
    assert!(
        DraftAttachments::from_startup(vec![
            json!({"ref": "/tmp/a.md", "fileName": "a.md", "mime": "text/markdown", "bytes": 1}),
            json!({"ref": "", "fileName": "x", "mime": "text/plain", "bytes": 1}),
        ])
        .is_err()
    );
}

#[test]
fn startup_values_dedupe_first_and_report_it() {
    let drafts = DraftAttachments::from_startup(vec![
        json!({"ref": "/tmp/a.md", "fileName": "a.md", "mime": "text/markdown", "bytes": 3}),
        json!({"ref": "/tmp/b.md", "fileName": "b.md", "mime": "text/markdown", "bytes": 4}),
        json!({"ref": "/tmp/a.md", "fileName": "a.md", "mime": "text/markdown", "bytes": 3}),
    ])
    .unwrap();
    assert_eq!(drafts.len(), 2);
    assert_eq!(drafts.items()[0].reference, "/tmp/a.md");
    assert_eq!(drafts.items()[0].bytes, 3, "保留首份的 metadata");
    // 去重结果可见：不是静默丢项，调用方可提示。
    assert_eq!(drafts.startup_duplicates(), 1);
}

#[test]
fn startup_rejects_more_than_the_core_cap() {
    let values = (0..17)
        .map(|index| {
            json!({
                "ref": format!("/tmp/f{index}.txt"),
                "fileName": format!("f{index}.txt"),
                "mime": "text/plain",
                "bytes": 1
            })
        })
        .collect::<Vec<_>>();
    let error = DraftAttachments::from_startup(values).unwrap_err();
    assert!(message(error).contains("16"));
}
