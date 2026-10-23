//! 补全的纯前端回归：候选来源、默认顺序、确认动作与面板边界。
//!
//! 这里只覆盖 `Completion` 自身；Tab/Enter 的真实 submit_editor 路由在
//! `transport_parity_tests`，两者共用同一份实现。
use super::*;
use crate::{editor::Editor, projection::View};
use ratatui::{Terminal, backend::TestBackend};

fn names(draft: &str) -> Vec<&'static str> {
    let mut completion = Completion::default();
    completion.reconcile(draft, true);
    completion.candidates().iter().map(|c| c.name).collect()
}

#[test]
fn prefix_and_alias_matches_stay_unique() {
    assert_eq!(names("/mo"), ["mode", "model"]);
    assert_eq!(names("/co"), ["compact"]);
    // 别名命中同一条命令时只出现一次。
    assert_eq!(names("/compress"), ["compact"]);
    assert_eq!(names("/variant"), ["effort"]);
    assert_eq!(names("/mcp"), ["mcp"]);
    assert_eq!(names("/usa"), ["usage"]);
    assert!(names("/compact now").is_empty());
    assert!(names("hello").is_empty());
    assert!(!names("/").is_empty());
}

#[test]
fn slash_defaults_to_help_in_directory_order() {
    // `/` 是空前缀：所有命令同分，默认项必须是目录里的第一条 help，
    // 不能因为额外的字母排序变成 compact。
    let candidates = names("/");
    assert_eq!(candidates.first(), Some(&"help"));
    let mut completion = Completion::default();
    completion.reconcile("/", true);
    assert_eq!(completion.replacement().as_deref(), Some("/help"));
}

#[test]
fn canonical_tokens_are_never_rewritten() {
    // 完整 canonical token 已被 rank 判为精确命中，默认项永远是它自己。
    for command in commands::all() {
        let draft = format!("/{}", command.name);
        let mut completion = Completion::default();
        completion.reconcile(&draft, true);
        assert_eq!(completion.candidates()[0].name, command.name);
        assert_eq!(completion.replacement().as_deref(), Some(draft.as_str()));
    }
}

#[test]
fn substring_candidates_confirm_to_their_canonical_name() {
    // 可见即可确认：`/odel` 只是 model 的子串命中，但选中后必须写回 `/model`。
    let mut completion = Completion::default();
    completion.reconcile("/odel", true);
    assert_eq!(names("/odel"), ["model"]);
    assert_eq!(completion.replacement().as_deref(), Some("/model"));
    // 别名仍归一化为 canonical。
    completion.reconcile("/comp", true);
    assert_eq!(completion.replacement().as_deref(), Some("/compact"));
    completion.reconcile("/compress", true);
    assert_eq!(completion.replacement().as_deref(), Some("/compact"));
    // 未知命令没有候选，绝不会被改写成某条控制命令。
    for draft in ["/compactfoo", "/nope"] {
        completion.reconcile(draft, true);
        assert!(completion.candidates().is_empty(), "{draft}");
        assert_eq!(completion.replacement(), None, "{draft}");
    }
    // 带参数/空白的草稿不是补全输入。
    assert_eq!(names("/compact now"), Vec::<&str>::new());
}

#[test]
fn arrow_selection_confirms_the_second_candidate() {
    let mut completion = Completion::default();
    completion.reconcile("/mo", true);
    assert_eq!(completion.selected(), 0);
    assert_eq!(completion.replacement().as_deref(), Some("/mode"));
    completion.move_by(1);
    assert_eq!(completion.replacement().as_deref(), Some("/model"));
}

#[test]
fn dismiss_and_busy_hide_until_draft_changes() {
    let mut completion = Completion::default();
    completion.reconcile("/mo", true);
    assert!(completion.visible());
    completion.dismiss();
    assert!(!completion.visible());
    assert_eq!(completion.replacement(), None);
    completion.reconcile("/mo", true);
    assert!(!completion.visible(), "Esc 对当前草稿持续生效");
    completion.reconcile("/mod", true);
    assert!(completion.visible());
    completion.reconcile("/mod", false);
    assert!(!completion.visible(), "busy/审批/选择器出现时失效");
}

#[test]
fn movement_wraps_and_selection_is_bounded() {
    let mut completion = Completion::default();
    completion.reconcile("/", true);
    let len = completion.candidates().len();
    assert!(len > 1);
    completion.move_by(-1);
    assert_eq!(completion.selected(), len - 1);
    completion.move_by(1);
    assert_eq!(completion.selected(), 0);
    completion.reconcile("/nope", true);
    assert_eq!(completion.selected(), 0);
    assert!(completion.candidates().is_empty());
}

#[test]
fn view_accept_completion_writes_back_without_sending() {
    let mut view = View::default();
    view.editor.insert("/mo");
    view.sync_completion();
    view.accept_completion();
    assert_eq!(view.editor.text(), "/mode");
    // 视图复位草稿后补全自然消失，不存在 accepted 队列。
    view.editor.clear();
    view.sync_completion();
    assert!(!view.completion.visible());
}

fn render(completion: &Completion, width: u16, height: u16, zh: bool) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| draw(frame, frame.area(), completion, zh))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .filter(|cell| !cell.symbol().is_empty())
        .map(|cell| cell.symbol())
        .collect()
}

#[test]
fn pane_is_bounded_and_bilingual() {
    let mut completion = Completion::default();
    completion.reconcile("/", true);
    let english = render(&completion, 80, 24, false);
    assert!(english.contains("/compact"));
    assert!(english.contains("Commands"));
    assert!(english.contains("Tab completes"));
    let chinese = render(&completion, 80, 24, true);
    // TestBackend 为全角字符保留一个占位 cell，逐字断言避免依赖 cell 拼接。
    for glyph in ["命", "令", "压", "缩", "补", "全"] {
        assert!(chinese.contains(glyph), "missing {glyph}: {chinese}");
    }
    // 最多 8 行候选，9 条命令不会全部出现。
    let body = english
        .lines()
        .filter(|line| line.contains(" /"))
        .collect::<Vec<_>>();
    assert!(body.len() <= MAX_VISIBLE + 1);
}

#[test]
fn pane_survives_tiny_and_empty_bounds() {
    let empty = Completion::default();
    let _ = render(&empty, 80, 24, false);
    let mut completion = Completion::default();
    completion.reconcile("/m", true);
    for (width, height) in [(1, 1), (11, 3), (12, 4), (13, 5), (200, 60)] {
        let _ = render(&completion, width, height, false);
    }
    // 选中最后一项时窗口仍覆盖它。
    completion.reconcile("/", true);
    completion.move_by(-1);
    let rendered = render(&completion, 40, 12, false);
    assert!(rendered.contains("›"));
}

#[test]
fn editor_replace_all_is_utf8_safe() {
    let mut editor = Editor::default();
    editor.insert("你🙂");
    editor.left();
    editor.replace_all("/mode");
    assert_eq!(editor.text(), "/mode");
    editor.insert("x");
    assert_eq!(editor.text(), "/modex");
}
