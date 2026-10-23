//! `@file` 面板/生命周期测试（从 `file_mentions_tests` 拆出以保持单文件 ≤400 行）。
#![allow(dead_code)]
use super::*;
use crate::editor::Editor;
use ratatui::{Terminal, backend::TestBackend, style::Color};

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

/// 手工构造一个已绑定 token 的控制器（不经过 sync 的默认状态）。
fn state(active: Active, generation: u64) -> FileMentions {
    let mut fm = FileMentions::default();
    fm.generation = generation;
    fm.directory = "workspace".into();
    fm.active = Some(active);
    fm
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

#[tokio::test]
async fn empty_state_dismissal_and_window_are_bounded() {
    let mut fm = FileMentions::default();
    let mut attachments = DraftAttachments::default();
    let mut editor = Editor::default();
    editor.insert("@x");
    // 未 sync 时 Enter 不被 mention 消费，交给后续处理器。
    assert!(!fm.accept(&mut editor, &mut attachments).unwrap());
    fm.sync(&editor, "  ", 1, false);
    assert!(!fm.visible());

    fm.active = Some(Active {
        trigger: 0,
        end: 2,
        token: "x".into(),
    });
    fm.items = (0..20)
        .map(|index| Entry {
            path: format!("d{index:02}/"),
            name: format!("d{index:02}"),
            directory: true,
            mime: "application/octet-stream".into(),
            bytes: 0,
        })
        .collect();
    assert_eq!(fm.window(), (0..8, 0));
    fm.move_by(-1);
    assert_eq!(fm.selected(), 19);
    assert_eq!(fm.window(), (12..20, 7));
    fm.move_by(1);
    assert_eq!(fm.selected(), 0);
    assert_eq!(fm.window(), (0..8, 0));
    // 空结果 Enter 只给提示，不改草稿。
    fm.items.clear();
    let text = editor.text().to_owned();
    assert!(fm.accept(&mut editor, &mut attachments).unwrap());
    assert_eq!(editor.text(), text);
    assert!(fm.notice().is_some());

    fm.active = Some(Active {
        trigger: 0,
        end: 2,
        token: "x".into(),
    });
    fm.dismiss();
    assert!(!fm.visible());
    // Esc 只对当前 token 生效，草稿变化后恢复。
    fm.sync(&editor, "  ", 1, true);
    assert!(!fm.visible());
    editor.insert("y");
    fm.sync(&editor, "  ", 1, true);
    assert!(fm.visible());
}

#[tokio::test]
async fn stale_results_and_generations_are_ignored_without_waiting() {
    let dir = workspace();
    let mut fm = FileMentions::default();
    let mut editor = Editor::default();
    editor.insert("@ma");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    // 刚启动的 task 还没被调度：poll 立刻返回 false，键盘不会等 IO。
    assert!(fm.loading());
    assert!(!fm.poll());

    // 旧 generation 的完成结果不得覆盖新状态。
    fm.active = Some(Active {
        trigger: 0,
        end: 3,
        token: "ma".into(),
    });
    fm.generation = 2;
    let key = fm.active.as_ref().unwrap().key();
    fm.items.clear();
    fm.inflight = Some(Inflight {
        key,
        generation: 1,
        handle: tokio::spawn(async { Ok((Vec::new(), false)) }),
    });
    for _ in 0..100 {
        if fm.inflight.as_ref().unwrap().handle.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(!fm.poll());
    assert!(fm.items.is_empty());

    // 切 token 后旧 query 结果同样作废，最终只展示新 token 的候选。
    let mut fm = FileMentions::default();
    let mut editor = Editor::default();
    editor.insert("@ma");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    editor.replace_range(0, 3, "@sr");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    settle(&mut fm).await;
    assert_eq!(active_paths(&fm), ["src/"]);
}

#[tokio::test]
async fn narrow_chinese_panel_renders_without_color() {
    let dir = workspace();
    let mut fm = FileMentions::default();
    let mut editor = Editor::default();
    editor.insert("@ma");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    settle(&mut fm).await;
    let mut terminal = Terminal::new(TestBackend::new(28, 12)).unwrap();
    terminal
        .draw(|frame| draw_with_color(frame, frame.area(), &fm, true, false))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = buffer
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("main.rs"), "{rendered}");
    // 双宽字符占据两个 cell，逐 cell 拼接后是「文 件」。
    assert!(
        rendered.contains('文') && rendered.contains('件'),
        "{rendered}"
    );
    assert!(
        buffer
            .content()
            .iter()
            .all(|cell| cell.fg == Color::Reset && cell.bg == Color::Reset),
        "NO_COLOR rendering must not set colors"
    );
}

#[test]
fn narrow_or_short_bounds_skip_the_panel() {
    let fm = state(
        Active {
            trigger: 0,
            end: 1,
            token: "x".into(),
        },
        1,
    );
    let mut terminal = Terminal::new(TestBackend::new(8, 3)).unwrap();
    terminal
        .draw(|frame| draw_with_color(frame, frame.area(), &fm, false, true))
        .unwrap();
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(!rendered.contains("Files"));
}

#[tokio::test]
async fn accept_revalidates_the_editor_token_before_attaching() {
    let dir = workspace();
    let mut fm = FileMentions::default();
    let mut attachments = DraftAttachments::default();
    let mut editor = Editor::default();
    editor.insert("@ma");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    settle(&mut fm).await;
    assert_eq!(active_paths(&fm), ["main.rs"]);
    // 候选还是旧的 `@ma`，但用户已经继续输入：Enter/Tab 不能按旧 cache 登记附件。
    editor.insert("in");
    assert_eq!(editor.text(), "@main");
    assert!(!fm.accept(&mut editor, &mut attachments).unwrap());
    assert!(
        attachments.is_empty(),
        "stale token must not attach a ghost file"
    );
    assert_eq!(editor.text(), "@main");

    // 光标离开 token（例如按 Tab 后插入空格）同样不能登记附件。
    let mut fm = FileMentions::default();
    let mut editor = Editor::default();
    editor.insert("@ma");
    fm.sync(&editor, &dir_of(&dir), 1, true);
    settle(&mut fm).await;
    editor.insert(" ");
    assert!(!fm.accept(&mut editor, &mut attachments).unwrap());
    assert!(attachments.is_empty());
    assert_eq!(editor.text(), "@ma ");
}

#[tokio::test]
async fn join_error_is_reported_instead_of_fake_empty_success() {
    let mut fm = state(
        Active {
            trigger: 0,
            end: 2,
            token: "x".into(),
        },
        3,
    );
    fm.loading = true;
    let key = fm.active.as_ref().unwrap().key();
    let handle = tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        Ok((Vec::new(), false))
    });
    let abort = handle.abort_handle();
    fm.inflight = Some(Inflight {
        key,
        generation: 3,
        handle,
    });
    abort.abort();
    for _ in 0..100 {
        if abort.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(fm.poll(), "join failure must produce a visible update");
    assert!(!fm.loading(), "loading may not stay stuck");
    assert!(
        fm.error().is_some(),
        "a cancelled query must not look like an empty success"
    );
    assert!(fm.items().is_empty());
}

#[tokio::test]
async fn dropping_the_controller_aborts_the_outstanding_query() {
    let mut fm = state(
        Active {
            trigger: 0,
            end: 2,
            token: "x".into(),
        },
        1,
    );
    let key = fm.active.as_ref().unwrap().key();
    let handle = tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        Ok((Vec::new(), false))
    });
    let abort = handle.abort_handle();
    fm.inflight = Some(Inflight {
        key,
        generation: 1,
        handle,
    });
    drop(fm);
    for _ in 0..100 {
        if abort.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        abort.is_finished(),
        "dropping must not leak an unowned task"
    );
}
