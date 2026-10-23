//! `@file` 状态机：Unicode 游标、目录/文件写回、删占位不发、上限提示与非阻塞查询。
use super::*;
use crate::editor::Editor;

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();
    std::fs::write(dir.path().join("src/lib.rs"), "pub fn a() {}").unwrap();
    dir
}

fn dir_of(dir: &tempfile::TempDir) -> String {
    dir.path().to_string_lossy().into_owned()
}

fn active_paths(fm: &FileMentions) -> Vec<String> {
    fm.items().iter().map(|e| e.path.clone()).collect()
}

async fn settle(fm: &mut FileMentions) {
    for _ in 0..400 {
        let changed = fm.poll();
        if changed || fm.inflight.is_none() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("workspace query did not settle");
}

#[test]
fn mention_tokens_follow_ts_rules_and_utf8_offsets() {
    let mut editor = Editor::default();
    editor.insert("看 @src/ma");
    let active = active_mention(editor.text(), editor.cursor_offset()).unwrap();
    assert_eq!(active.token, "src/ma");
    assert_eq!(active.trigger, "看 ".len());
    assert_eq!(editor.cursor_offset(), "看 @src/ma".len());
    // 行首之外必须有空白：邮箱不是 mention。
    assert!(active_mention("mail@host", 9).is_none());
    // token 内有空白就不是同一个 mention。
    assert!(active_mention("@a b", 4).is_none());
    // 非字符边界的 cursor 回退到最近的合法边界，不 panic。
    let text = "@a🙂b";
    let inside_emoji = 3;
    assert_eq!(
        active_mention(text, inside_emoji).map(|a| a.token),
        Some("a".to_owned())
    );
    assert!(active_mention("plain text", 10).is_none());
}

#[test]
fn replace_range_is_utf8_safe_and_keeps_other_edits() {
    let mut editor = Editor::default();
    editor.insert("你🙂x");
    // 半字节范围与越界范围都不修改编辑器。
    assert!(!editor.replace_range(1, 2, "y"));
    assert!(!editor.replace_range(0, 99, "y"));
    assert!(!editor.replace_range(3, 1, "y"));
    assert_eq!(editor.text(), "你🙂x");
    // 合法范围替换后游标落在替换文本末尾。
    assert!(editor.replace_range(0, "你".len(), "@dir/"));
    assert_eq!(editor.text(), "@dir/🙂x");
    assert_eq!(editor.cursor_offset(), "@dir/".len());
}

#[tokio::test]
async fn directory_selection_continues_and_file_selection_attaches() {
    let dir = workspace();
    let mut fm = FileMentions::default();
    let mut attachments = DraftAttachments::default();
    let mut editor = Editor::default();
    editor.insert("@sr");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    settle(&mut fm).await;
    assert_eq!(active_paths(&fm), ["src/"]);
    assert!(fm.accept(&mut editor, &mut attachments).unwrap());
    assert_eq!(editor.text(), "@src/");
    assert!(attachments.is_empty(), "directory must not attach a file");
    // 目录补全后同一个 token 继续给出子目录内容。
    fm.sync(&editor, &dir_of(&dir), 1, true);
    settle(&mut fm).await;
    assert_eq!(active_paths(&fm), ["src/lib.rs"]);

    let mut editor = Editor::default();
    editor.insert("see @ma");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    settle(&mut fm).await;
    assert!(fm.accept(&mut editor, &mut attachments).unwrap());
    assert_eq!(editor.text(), "see @main.rs ");
    let refs = attachments.refs_for_text(editor.text());
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0]["ref"], "main.rs");
    assert_eq!(refs[0]["bytes"], "fn main() {}".len() as u64);
    // 这一次 Enter 只写草稿，不产生任何提交动作。
    assert!(!fm.accept(&mut editor, &mut attachments).unwrap());
}

#[tokio::test]
async fn deleting_the_placeholder_removes_the_attachment() {
    let dir = workspace();
    let mut fm = FileMentions::default();
    let mut attachments = DraftAttachments::default();
    assert_eq!(
        attachments.attach_entry(&Entry {
            path: "main.rs".into(),
            name: "main.rs".into(),
            directory: false,
            mime: "text/plain".into(),
            bytes: 12,
        }),
        AttachResult::Added
    );
    let mut editor = Editor::default();
    editor.insert("@main.rs hi");
    // 光标回到占位符末尾：mention 只在 token 内部激活。
    while editor.cursor_offset() > "@main.rs".len() {
        editor.left();
    }
    fm.sync(&editor, &dir_of(&dir), 1, true);
    assert!(fm.visible());
    assert_eq!(attachments.refs_for_text(editor.text()).len(), 1);
    // 用户手动删除占位符后，对应附件不再发送。
    editor.replace_range(0, "@main.rs".len(), "");
    assert_eq!(editor.text(), " hi");
    attachments.retain_for_text(editor.text());
    assert!(attachments.refs_for_text(editor.text()).is_empty());
}

#[tokio::test]
async fn attachment_limit_is_reported_instead_of_dropping_silently() {
    let dir = workspace();
    let mut fm = FileMentions::default();
    let mut attachments = DraftAttachments::default();
    for index in 0..16 {
        let path = format!("f{index}.txt");
        assert_eq!(
            attachments.attach_entry(&Entry {
                path: path.clone(),
                name: path.clone(),
                directory: false,
                mime: "text/plain".into(),
                bytes: 1,
            }),
            AttachResult::Added
        );
    }
    let mut editor = Editor::default();
    editor.insert("@ma");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    settle(&mut fm).await;
    assert!(fm.accept(&mut editor, &mut attachments).unwrap());
    // 正文保持原样，附件数不变，提示明确。
    assert_eq!(editor.text(), "@ma");
    assert_eq!(attachments.len(), 16);
    assert!(fm.notice().unwrap().contains("16"));
}
