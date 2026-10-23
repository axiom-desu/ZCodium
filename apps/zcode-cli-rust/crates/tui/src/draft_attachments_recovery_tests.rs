//! 草稿附件历史恢复：本地 refs 解析、类型核对、去重与启动项合并上限。
use super::draft_attachments_tests::{draft_with, entry, message, startup};
use super::*;
use serde_json::json;
use zcode_cli_protocol::AttachmentRef;

#[test]
fn history_restores_local_files_with_text_placeholders() {
    let directory = "/workspace/project";
    let attachments = json!([
        {"type": "file", "path": "/workspace/project/src/main.rs"},
        {"type": "file", "path": "README.md"}
    ]);
    // 历史正文记的是相对路径；绝对 path 必须认得出同一个占位符。
    let mut drafts =
        DraftAttachments::from_history(&attachments, directory, "see @src/main.rs and @README.md")
            .unwrap();
    assert_eq!(drafts.len(), 2);
    assert_eq!(
        drafts.items()[0].placeholder.as_deref(),
        Some("@src/main.rs")
    );
    assert_eq!(
        drafts.items()[0].reference,
        "/workspace/project/src/main.rs"
    );
    assert_eq!(drafts.items()[0].mime, "text/plain");
    assert_eq!(drafts.items()[0].bytes, 0, "TUI 不读内容，由 core 核实");
    let text = "see @src/main.rs and @README.md";
    let refs = drafts.refs_for_text(text);
    assert_eq!(refs.len(), 2);
    assert_eq!(refs[0]["ref"], json!("/workspace/project/src/main.rs"));
    // 删除其中一个占位符只影响那一个。
    drafts.retain_for_text("see @src/main.rs");
    assert_eq!(drafts.len(), 1);
    assert_eq!(
        drafts.items()[0].reference,
        "/workspace/project/src/main.rs"
    );
    // inline 项仍按 token 边界匹配：`@a` 不能从 `@ab` 里被误配，删掉后不再发送。
    let mut other =
        DraftAttachments::from_history(&json!([{"type": "file", "path": "a"}]), directory, "@a x")
            .unwrap();
    assert_eq!(other.items()[0].placeholder.as_deref(), Some("@a"));
    assert_eq!(other.refs_for_text("@a x").len(), 1);
    assert!(other.refs_for_text("@ab").is_empty());
    other.retain_for_text("@ab");
    assert!(other.is_empty());
}

#[test]
fn history_restores_local_images_and_pdfs_with_derived_mime() {
    let directory = "/workspace/project";
    let attachments = json!([
        {"type": "image", "path": "/workspace/project/assets/diagram.png"},
        {"type": "pdf", "path": "docs/spec.pdf"},
        {"type": "image", "path": "shots/photo.JPEG"}
    ]);
    let text = "look @assets/diagram.png and @docs/spec.pdf and @shots/photo.JPEG";
    let drafts = DraftAttachments::from_history(&attachments, directory, text).unwrap();
    assert_eq!(drafts.len(), 3);
    assert_eq!(drafts.items()[0].mime, "image/png");
    assert_eq!(drafts.items()[1].mime, "application/pdf");
    assert_eq!(drafts.items()[2].mime, "image/jpeg");
    assert_eq!(drafts.items()[0].file_name, "diagram.png");
    let refs = drafts.refs_for_text(text);
    assert_eq!(refs.len(), 3);
    for (value, expected) in refs
        .iter()
        .zip(["image/png", "application/pdf", "image/jpeg"])
    {
        assert_eq!(value["mime"], json!(expected));
        assert_eq!(value["bytes"], json!(0));
    }
    let parsed: AttachmentRef = serde_json::from_value(refs[0].clone()).unwrap();
    assert_eq!(parsed.r#ref, "/workspace/project/assets/diagram.png");
}

#[test]
fn history_without_a_placeholder_restores_pinned_attachments() {
    let directory = "/workspace/project";
    // 启动 `--attach` 的本地绝对路径在 workspace 内：没有 @token，恢复成 pinned。
    let inside = json!([{"type": "file", "path": "/workspace/project/notes.md"}]);
    let mut pinned =
        DraftAttachments::from_history(&inside, directory, "plain recalled text").unwrap();
    assert_eq!(pinned.len(), 1);
    assert_eq!(pinned.items()[0].placeholder, None);
    assert_eq!(
        pinned.refs_for_text("plain recalled text").len(),
        1,
        "没有占位符也必须带上 pinnned 附件，不能空 refs 丢附件"
    );
    pinned.retain_for_text("plain recalled text");
    assert_eq!(pinned.len(), 1);

    // workspace 外的本地绝对路径（--attach 来源）同样是 pinned，不扩成 @ 建议。
    let outside = json!([{"type": "pdf", "path": "/tmp/report.pdf"}]);
    let external = DraftAttachments::from_history(&outside, directory, "text").unwrap();
    assert_eq!(external.len(), 1);
    assert_eq!(external.items()[0].placeholder, None);
    assert_eq!(external.items()[0].reference, "/tmp/report.pdf");
    assert_eq!(external.refs_for_text("").len(), 1);

    // 含空白的本地路径无法写进 @token，同样按 pinned 恢复而不是丢项。
    let spaced = json!([{"type": "file", "path": "my notes.md"}]);
    let drafts = DraftAttachments::from_history(&spaced, directory, "text").unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts.items()[0].placeholder, None);
    assert_eq!(drafts.refs_for_text("text").len(), 1);
}

#[test]
fn history_restore_rejects_what_it_cannot_prove() {
    let directory = "/workspace/project";
    for invalid in [
        // artifact/凭证：不能编造字节或跨 session 复用 ref。
        json!([{"type": "artifact", "path": "zcode-artifact://s/x"}]),
        // 内联 content：TUI 不读内容字节。
        json!([{"type": "image", "content": "data:image/png;base64,AAAA"}]),
        json!([{"type": "file", "content": "inline text"}]),
        // 未知/缺失类型。
        json!([{"type": "url", "path": "https://example.com/x"}]),
        json!([{"path": "a.txt"}]),
        // 缺失/非法 path。
        json!([{"type": "file"}]),
        json!([{"type": "file", "path": ""}]),
        json!([{"type": "file", "path": "bad\u{1}.txt"}]),
        json!([{"type": "file", "path": "bad\n.txt"}]),
        // 类型与派生 MIME 不一致，不能编一个合法 MIME 蒙过去。
        json!([{"type": "image", "path": "notes.md"}]),
        json!([{"type": "pdf", "path": "notes.md"}]),
        // 结构错误。
        json!("nope"),
        json!({"type": "file"}),
    ] {
        assert!(
            DraftAttachments::from_history(&invalid, directory, "@a").is_err(),
            "must reject: {invalid}"
        );
    }
    assert!(
        DraftAttachments::from_history(&Value::Null, directory, "")
            .unwrap()
            .is_empty()
    );
    // 超出上限同样显式报错，不静默丢附件。
    let many = Value::Array(
        (0..17)
            .map(|index| json!({"type": "file", "path": format!("f{index}.txt")}))
            .collect(),
    );
    let error = DraftAttachments::from_history(&many, directory, "").unwrap_err();
    assert!(message(error).contains("16"));
}

#[test]
fn history_dedupes_repeated_sources_and_keeps_first() {
    let directory = "/workspace/project";
    let attachments = json!([
        {"type": "file", "path": "src/lib.rs"},
        {"type": "file", "path": "src/lib.rs"},
        {"type": "file", "path": "./src/lib.rs"}
    ]);
    let drafts = DraftAttachments::from_history(&attachments, directory, "@src/lib.rs").unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts.items()[0].reference, "src/lib.rs");
    assert_eq!(drafts.refs_for_text("@src/lib.rs").len(), 1);
}

#[test]
fn draft_is_cloneable_for_history_round_trips_and_snapshots() {
    let mut drafts = draft_with("@notes.md");
    drafts.attach_entry(&entry("src/lib.rs", 9));
    let text = "@notes.md @src/lib.rs";
    let saved = drafts.clone();
    assert_eq!(saved.refs_for_text(text), drafts.refs_for_text(text));
    drafts.retain_for_text("@notes.md");
    assert_eq!(drafts.len(), 1);
    // snapshot/历史保存的是整份草稿副本，恢复后仍是同一组附件。
    assert_eq!(saved.len(), 2);
    assert_eq!(saved, saved.clone());
    let restored =
        DraftAttachments::from_history(&json!([{"type": "file", "path": "src/lib.rs"}]), ".", text)
            .unwrap();
    assert_eq!(restored.refs_for_text(text).len(), 1);
    assert_eq!(restored.items()[0].reference, "src/lib.rs");
}

#[test]
fn sources_distinguish_startup_from_mentions_and_history_pins() {
    assert_eq!(
        draft_with("@a.txt").items()[0].source,
        AttachmentSource::Mention
    );
    let started = startup(json!({
        "ref": "/tmp/report.pdf", "fileName": "report.pdf",
        "mime": "application/pdf", "bytes": 1
    }))
    .unwrap();
    assert_eq!(started.items()[0].source, AttachmentSource::Startup);
    let pinned = DraftAttachments::from_history(
        &json!([{"type": "pdf", "path": "/tmp/report.pdf"}]),
        "/ws",
        "text",
    )
    .unwrap();
    assert_eq!(pinned.items()[0].source, AttachmentSource::History);
}

#[test]
fn adopting_a_startup_item_merges_by_reference_once_and_stays_under_the_cap() {
    let saved = startup(json!({
        "ref": "/tmp/report.pdf", "fileName": "report.pdf",
        "mime": "application/pdf", "bytes": 0
    }))
    .unwrap();
    let mut restored = DraftAttachments::from_history(
        &json!([{"type": "file", "path": "a.txt"}]),
        "/ws",
        "@a.txt",
    )
    .unwrap();
    for item in saved.items() {
        restored.adopt(item).unwrap();
    }
    // 重复来源不再加一份，同一 ref 只有一个 owner。
    restored.adopt(&saved.items()[0]).unwrap();
    assert_eq!(restored.len(), 2);
    assert_eq!(
        restored
            .items()
            .iter()
            .filter(|item| item.source == AttachmentSource::Startup)
            .count(),
        1
    );

    // 超上限显式报错，调用方保留原草稿。
    let many = DraftAttachments::from_startup(
        (0..16)
            .map(|index| {
                json!({
                    "ref": format!("/ws/f{index}.txt"),
                    "fileName": format!("f{index}.txt"),
                    "mime": "text/plain",
                    "bytes": 1
                })
            })
            .collect(),
    )
    .unwrap();
    let mut full =
        DraftAttachments::from_history(&json!([{"type": "file", "path": "a.txt"}]), "/ws", "")
            .unwrap();
    let mut failures = 0;
    for item in many.items() {
        if full.adopt(item).is_err() {
            failures += 1;
        }
    }
    assert_eq!(failures, 1);
    assert_eq!(full.len(), 16);
}

#[test]
fn history_refs_keep_their_source_bytes_including_trailing_spaces() {
    let drafts = DraftAttachments::from_history(
        &json!([{"type": "file", "path": "notes.md "}]),
        "/ws",
        "no placeholder",
    )
    .unwrap();
    assert_eq!(drafts.items()[0].reference, "notes.md ");
    assert_eq!(drafts.items()[0].placeholder, None);
    assert_eq!(drafts.refs_for_text("")[0]["ref"], json!("notes.md "));
}
