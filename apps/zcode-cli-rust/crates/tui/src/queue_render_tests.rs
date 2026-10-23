//! 队列条/编辑弹层的渲染边界：宽度、行数上限、ANSI 清理与真实 paused 状态。
use crate::{projection::View, queue, queue_render, queue_state, queue_state::QueueEdit};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::{Value, json};

fn item(id: &str, kind: &str, text: &str) -> Value {
    json!({"queueItemId":id,"kind":kind,"text":text,"attachments":[],
        "delivery":{"requested":"auto","admitted":"queue"},
        "dispatch":{"state":"queued"},"order":{"queuePosition":0}})
}

fn queue_view(items: Value, auto_drain: bool) -> View {
    let mut view = View::default();
    view.snapshot(&json!({
        "sessionId":"s","seq":1,"logEpoch":"epoch-1","revision":7,
        "rows":{"window":[]},"control":{"canStop":true},"config":{"mode":"build"},
        "availability":{"queueEdit":{"allowed":true},"sendQueuedNow":{"allowed":true}},
        "queue":{"items":items,"autoDrain":auto_drain},"pendingInteractions":[]
    }));
    view
}

#[test]
fn queue_strip_shows_three_items_plus_the_real_remainder() {
    let items = json!([
        item("q1", "sendText", "first"),
        item("q2", "sendText", "second"),
        item("q3", "sendText", "third"),
        item("q4", "sendText", "fourth"),
        item("q5", "sendText", "fifth")
    ]);
    let view = queue_view(items, true);
    let lines = queue_render::render_lines(&view, 80);
    assert!(lines[0].contains("Queued 5"), "{:?}", lines);
    // 队头 3 项 + 一条 more，后面不再展开。
    assert_eq!(lines.len(), 5);
    assert!(lines[1].contains("q1"));
    assert!(lines[2].contains("q2"));
    assert!(lines[3].contains("q3"));
    assert!(!lines.iter().any(|line| line.contains("q4")));
    assert!(lines[4].contains("+2"), "{:?}", lines);
}

#[test]
fn paused_state_comes_from_actor_not_from_queue_length() {
    let paused = queue_view(json!([item("q1", "sendText", "a")]), false);
    let lines = queue_render::render_lines(&paused, 80);
    assert!(lines[0].contains("Queue paused"), "{lines:?}");
    assert!(lines[0].contains("/queue resume"), "{lines:?}");

    let draining = queue_view(json!([item("q1", "sendText", "a")]), true);
    let lines = queue_render::render_lines(&draining, 80);
    assert!(!lines[0].contains("paused"), "{lines:?}");

    // 空队列不渲染队列条（不能靠 UI 造出队列事实）。
    let empty = queue_view(json!([]), false);
    assert!(queue_render::render_lines(&empty, 80).is_empty());
}

#[test]
fn every_line_is_width_capped_and_ansi_free() {
    let long = format!("{} \x1b[31mred\x1b[0m tail", "x".repeat(120));
    let view = queue_view(
        json!([item("q1", "sendText", &long), item("q2", "compact", "y")]),
        true,
    );
    let width = 24;
    for line in queue_render::render_lines(&view, width) {
        assert!(line.chars().count() <= width, "{line:?}");
        assert!(!line.contains('\x1b'), "ANSI 必须被清理：{line:?}");
        assert!(!line.contains('\n'));
    }
    // 极窄宽度也不能 panic 或越界。
    for line in queue_render::render_lines(&view, 1) {
        assert!(line.chars().count() <= 1);
    }
    assert!(queue_render::render_lines(&view, 0).is_empty());
}

#[test]
fn menu_labels_keep_ids_and_drop_terminal_escapes() {
    let view = queue_view(
        json!([item("q1", "sendText", "\x1b[32mhello\x1b[0m world")]),
        false,
    );
    let selector = queue::open(&view).unwrap();
    let (_, label) = selector.options.first().unwrap();
    assert!(label.contains("q1"), "{label}");
    assert!(label.contains("hello"), "{label}");
    assert!(!label.contains('\x1b'), "{label}");
}

#[test]
fn draw_edit_renders_the_local_draft_and_its_hints() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let mut edit = QueueEdit::from_item(&view, &queue_state::items(&view)[0], 7, "epoch-1");
    edit.editor.replace_all("queued draft text");
    view.queue_edit = Some(edit);

    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    terminal
        .draw(|frame| queue_render::draw_edit(frame, frame.area(), &view))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = buffer
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("queued draft text"), "{rendered}");
    assert!(rendered.contains("Enter"), "{rendered}");
    assert!(rendered.contains("Esc"), "{rendered}");
    assert!(rendered.contains("q1"), "{rendered}");
}

#[test]
fn draw_edit_without_a_draft_draws_nothing() {
    let view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    terminal
        .draw(|frame| queue_render::draw_edit(frame, frame.area(), &view))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = buffer
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(!rendered.contains("Enter"), "{rendered}");
}

fn render_edit(view: &View) -> String {
    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    terminal
        .draw(|frame| queue_render::draw_edit(frame, frame.area(), view))
        .unwrap();
    terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>()
}

/// 权限/问答优先：弹层自己暂停，未来调用方漏了外层门禁也不能盖在必答题上。
#[test]
fn draw_edit_pauses_while_an_interaction_must_be_answered() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let mut edit = QueueEdit::from_item(&view, &queue_state::items(&view)[0], 7, "epoch-1");
    edit.editor.replace_all("queued draft text");
    view.queue_edit = Some(edit);
    assert!(render_edit(&view).contains("queued draft text"));

    view.state["pendingInteractions"] = json!([{"interactionId":"i1"}]);
    let rendered = render_edit(&view);
    assert!(!rendered.contains("queued draft text"), "{rendered}");
    assert!(!rendered.contains("Enter"), "{rendered}");
}

/// 旧世代编辑不自动隐藏：同一 buffer 带失效标题，并明确 Esc 取消。
#[test]
fn draw_edit_marks_a_foreign_generation_as_stale_instead_of_hiding_it() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let mut edit = QueueEdit::from_item(&view, &queue_state::items(&view)[0], 7, "epoch-1");
    edit.editor.replace_all("stale draft text");
    view.queue_edit = Some(edit);
    assert!(render_edit(&view).contains("stale draft text"));

    view.generation = view.generation.wrapping_add(1);
    let rendered = render_edit(&view);
    assert!(rendered.contains("stale draft text"), "{rendered}");
    assert!(rendered.contains("Stale queue edit"), "{rendered}");
    assert!(rendered.contains("Esc"), "{rendered}");
    assert!(!rendered.contains("Enter save"), "{rendered}");
}

/// 裁剪按终端显示宽度，CJK/emoji 不会超出列宽也不会把半个字截断。
#[test]
fn clip_uses_display_width_not_character_count() {
    let wide = format!("{} endings", "队列正文".repeat(12));
    let view = queue_view(json!([item("q1", "sendText", &wide)]), true);
    let width = 20;
    for line in queue_render::render_lines(&view, width) {
        assert!(
            ratatui::text::Line::raw(line.as_str()).width() <= width,
            "{line:?} must fit {width} columns"
        );
        assert!(!line.contains('\u{1b}'));
    }
}
