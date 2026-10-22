//! composer 底栏与 timelineMarker 的展示对齐测试（ratatui TestBackend）。
#![allow(clippy::field_reassign_with_default)]

use crate::{
    presentation::{RenderCache, draw},
    presentation_markers::marker_line,
    presentation_status::composer_status,
    projection::View,
};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::json;

fn view_with(config: serde_json::Value) -> View {
    let mut view = View::default();
    view.state = json!({"config": config});
    view
}

fn render(view: &View, width: u16, height: u16) -> String {
    render_with_cache(view, width, height, &mut RenderCache::default())
}

fn render_with_cache(view: &View, width: u16, height: u16, cache: &mut RenderCache) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| draw(frame, view, cache, 0)).unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect()
}

fn screen_rows(view: &View, width: u16, height: u16) -> Vec<String> {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal
        .draw(|frame| draw(frame, view, &mut RenderCache::default(), 0))
        .unwrap();
    let buffer = terminal.backend().buffer().clone();
    (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buffer.content[(y * width + x) as usize].symbol())
                .collect()
        })
        .collect()
}

fn cells(text: &str) -> usize {
    ratatui::text::Line::raw(text).width()
}

// ---------------------------------------------------------------- composer

#[test]
fn composer_shows_model_provider_and_thought_hierarchy() {
    let view = view_with(json!({"model":"claude-opus-4","provider":"anthropic","thought":"high"}));
    let line = composer_status(&view, 100);
    let text = line
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect::<String>();
    assert_eq!(text, "claude-opus-4 anthropic | high");
    // model 主信息，provider 弱化，thought 强调：与 TS app-input-status 一致。
    assert_ne!(line.spans[0].style.fg, line.spans[2].style.fg);
    let screen = render(&view, 100, 24);
    assert!(screen.contains("claude-opus-4 anthropic | high"));
}

#[test]
fn composer_missing_fields_use_placeholder_without_borrowing_values() {
    let view = view_with(json!({"model":"m1"}));
    let text = composer_status(&view, 80)
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect::<String>();
    assert_eq!(text, "m1 — | —");
    let empty = view_with(json!({}));
    let text = composer_status(&empty, 80)
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect::<String>();
    assert_eq!(text, "— — | —");
    // 不因为没有 provider 就把 model 当成 provider 或伪造 thought。
    assert!(!text.contains("m1"));
}

#[test]
fn composer_fits_display_width_not_char_count() {
    // 每个 CJK 字符占 2 列：按 chars 计数会溢出，按显示宽度才不会。
    let view = view_with(json!({
        "model": "模型-超级长的模型名称",
        "provider": "供应商-很长的名字",
        "thought": "很高"
    }));
    for width in 1..=60u16 {
        let line = composer_status(&view, width);
        assert!(
            cells(
                &line
                    .spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            ) <= width as usize,
            "composer overflows at width {width}: {line:?}"
        );
    }
    // 宽终端完整显示；窄终端保留 thought 并截断 model/provider。
    let wide = composer_status(&view, 60);
    assert!(
        wide.spans
            .iter()
            .any(|s| s.content.contains("模型-超级长的模型名称"))
    );
    let narrow = composer_status(&view, 20);
    let narrow_text = narrow
        .spans
        .iter()
        .map(|s| s.content.as_ref())
        .collect::<String>();
    assert!(narrow_text.contains("很高"), "{narrow_text}");
    assert!(narrow_text.contains("..."), "{narrow_text}");
    assert!(
        !narrow_text.contains("模型-超级长的模型名称"),
        "model is truncated: {narrow_text}"
    );
}

#[test]
fn composer_cleans_ansi_osc_and_control_characters() {
    let view = view_with(json!({
        "model": "safe\u{1b}[31m red\u{1b}]0;title\u{0007}",
        "provider": "prov\u{0000}\tider",
        "thought": "hi\ngh"
    }));
    let (model, provider, thought) = crate::presentation_status::parts(&view);
    for field in [&model, &provider, &thought] {
        assert!(!field.contains('\u{1b}'), "{field:?}");
        assert!(!field.contains('\u{0007}'), "{field:?}");
        assert!(!field.contains('\n'), "{field:?}");
        assert!(!field.chars().any(|c| c.is_control()), "{field:?}");
    }
    let screen = render(&view, 80, 24);
    assert!(!screen.contains("title"));
    assert!(!screen.contains('\u{1b}'));
}

#[test]
fn composer_no_color_and_tiny_buffers_do_not_overflow() {
    let mut view = view_with(json!({
        "model": "模型🙂🙂🙂🙂🙂🙂🙂🙂",
        "provider": "provider-name",
        "thought": "medium"
    }));
    view.no_color = true;
    for (width, height) in [(1, 1), (2, 4), (8, 4), (12, 6), (40, 12), (140, 30)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| draw(frame, &view, &mut RenderCache::default(), 0))
            .unwrap();
        for cell in terminal.backend().buffer().content.iter() {
            assert_eq!(cell.fg, ratatui::style::Color::Reset);
            assert_eq!(cell.bg, ratatui::style::Color::Reset);
        }
        let pos = terminal.get_cursor_position().unwrap();
        assert!(pos.x < width && pos.y < height);
    }
    // 极小高度不渲染底栏，也不 panic。
    let _ = render(&view, 20, 2);
}

#[test]
fn composer_keeps_sidebar_status_regressions() {
    // session/running 信息仍留在侧栏 Status，而不是被塞回底栏。
    let mut view = view_with(json!({"model":"m1","provider":"p1","thought":"low"}));
    view.sidebar = true;
    view.directory = "/work".into();
    view.pending_submit = true;
    let rows = screen_rows(&view, 150, 40);
    let all = rows.join("\n");
    assert!(all.contains("Status"), "{all}");
    assert!(all.contains("Running"), "{all}");
    assert!(all.contains("m1 p1 | low"), "{all}");
}

// ----------------------------------------------------------------- markers

fn compact_row(marker: serde_json::Value) -> serde_json::Value {
    json!({"kind":"timelineMarker","marker":marker})
}

fn line_text(line: &ratatui::text::Line<'_>) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

#[test]
fn compact_markers_cover_every_real_status_and_origin() {
    let statuses = [
        ("running", "Compressing context", "正在压缩上下文"),
        ("success", "Context compressed", "上下文已压缩"),
        ("noop", "Context is up to date", "上下文已是最新"),
        ("failed", "Context compression failed", "上下文压缩失败"),
        (
            "cancelled",
            "Context compression interrupted",
            "上下文压缩已中断",
        ),
    ];
    for (status, en, zh) in statuses {
        let row = compact_row(json!({
            "type":"compact","origin":"manual","status":status,
            "tokensBefore": 12345, "tokensAfter": 4200
        }));
        let en_line = line_text(&marker_line(&row, false).expect(status));
        let zh_line = line_text(&marker_line(&row, true).expect(status));
        assert!(en_line.contains(en), "{status}: {en_line}");
        assert!(zh_line.contains(zh), "{status}: {zh_line}");
        // 真实存在的 token 字段才展示，并压缩为短格式。
        for line in [&en_line, &zh_line] {
            assert!(line.contains("12.3K → 4.2K"), "{status}: {line}");
            assert!(!line.contains("12345"), "{status}: {line}");
        }
        assert!(en_line.contains("(manual)"), "{status}: {en_line}");
        assert!(zh_line.contains("（手动）"), "{status}: {zh_line}");
    }
    let auto = compact_row(json!({"type":"compact","origin":"auto","status":"success"}));
    let auto_line = line_text(&marker_line(&auto, false).unwrap());
    assert!(auto_line.contains("(auto)"), "{auto_line}");
    let auto_zh = line_text(&marker_line(&auto, true).unwrap());
    assert!(auto_zh.contains("（自动）"), "{auto_zh}");
}

#[test]
fn compact_markers_never_invent_tokens_or_status() {
    let absent = compact_row(json!({"type":"compact","origin":"auto","status":"success"}));
    let line = line_text(&marker_line(&absent, false).unwrap());
    assert!(!line.contains("tokens"), "{line}");
    assert!(!line.contains('→'), "{line}");
    assert!(!line.contains("0"), "{line}");

    let before_only = compact_row(
        json!({"type":"compact","origin":"manual","status":"running","tokensBefore":900}),
    );
    let line = line_text(&marker_line(&before_only, false).unwrap());
    assert!(line.contains("before 900"), "{line}");
    assert!(!line.contains('→'), "{line}");

    // 未知 status 不猜测成败。
    let unknown = compact_row(json!({"type":"compact","origin":"manual","status":"teleported"}));
    assert!(marker_line(&unknown, false).is_none());

    // 未知 marker 类型不造事实：整行不输出，也不 dump JSON。
    let mystery = compact_row(json!({"type":"mystery","payload":{"secret":"value"}}));
    assert!(marker_line(&mystery, false).is_none());
    let no_marker = json!({"kind":"timelineMarker","text":"raw"});
    assert!(marker_line(&no_marker, false).is_none());
}

#[test]
fn compact_failure_detail_is_bounded_and_cleaned() {
    let row = compact_row(json!({
        "type":"compact","origin":"auto","status":"failed",
        "error": {"message": format!("boom\u{1b}[31m{}\u{0007}","x".repeat(400))}
    }));
    let line = line_text(&marker_line(&row, false).unwrap());
    assert!(line.contains("boom"), "{line}");
    assert!(!line.contains('\u{1b}'));
    assert!(!line.contains('\u{0007}'));
    assert!(line.chars().count() <= 260, "bounded: {}", line.len());
}

#[test]
fn model_change_rewind_goal_and_fork_markers_use_real_fields() {
    let change = compact_row(
        json!({"type":"modelChange","fromProvider":"p1","fromModel":"m1",
        "toProvider":"p2","toModel":"m2","toThought":"high"}),
    );
    let en = line_text(&marker_line(&change, false).unwrap());
    assert!(en.contains("m1 → m2"), "{en}");
    assert!(en.contains("(p2)"), "{en}");
    assert!(en.contains("high"), "{en}");
    assert!(!en.contains("p1"), "{en}");
    let zh = line_text(&marker_line(&change, true).unwrap());
    assert!(zh.contains("模型切换"), "{zh}");

    // 首轮模型没有 from* 字段，不显示假的来源。
    let initial = compact_row(json!({"type":"modelChange","toModel":"m2","toThought":"low"}));
    let en = line_text(&marker_line(&initial, false).unwrap());
    assert!(en.contains("Model: m2"), "{en}");
    assert!(!en.contains('→'), "{en}");

    let restored =
        compact_row(json!({"type":"checkpointRestored","checkpointId":"uuid-1234-abcdef"}));
    let en = line_text(&marker_line(&restored, false).unwrap());
    assert!(en.contains("checkpoint"), "{en}");
    assert!(!en.contains("uuid-1234"), "{en}");

    let goal = compact_row(
        json!({"type":"goalVerify","iteration":2,"outcome":"notSatisfied","detail":"tests fail\u{1b}[0m"}),
    );
    let en = line_text(&marker_line(&goal, false).unwrap());
    assert!(en.contains("#2"), "{en}");
    assert!(en.contains("not satisfied"), "{en}");
    assert!(en.contains("tests fail"), "{en}");
    assert!(!en.contains('\u{1b}'));

    let fork =
        compact_row(json!({"type":"forkNotice","parentSessionId":"parent-uuid","parentRowId":0}));
    let zh = line_text(&marker_line(&fork, true).unwrap());
    assert!(zh.contains("分叉"), "{zh}");
    assert!(!zh.contains("parent-uuid"), "{zh}");
}

#[test]
fn marker_rows_render_in_transcript_and_refresh_after_upsert() {
    let running = json!({
        "rowId": 7, "kind":"timelineMarker",
        "marker": {"type":"compact","origin":"manual","status":"running","tokensBefore": 8000}
    });
    let mut view = View::default();
    view.snapshot(&json!({
        "sessionId":"s","seq":1,
        "rows":{"window":[running.clone()]},
        "config":{"model":"m","provider":"p","thought":"low"}
    }));
    let mut cache = RenderCache::default();
    let first = render_with_cache(&view, 80, 20, &mut cache);
    assert!(first.contains("Compressing context"), "{first}");
    assert!(first.contains("before 8K"), "{first}");
    assert!(!first.contains("rowId"), "marker JSON is not dumped");

    // 真实的状态更新走 row.upserted：缓存必须失效并显示新状态。
    let mut updated = running.clone();
    updated["marker"] = json!({"type":"compact","origin":"manual","status":"success",
        "tokensBefore": 8000, "tokensAfter": 2000});
    view.deltas(
        "s",
        1,
        2,
        vec![json!({"op":"row.upserted","row": updated})].into_iter(),
    );
    let hits_before = cache.hits;
    let second = render_with_cache(&view, 80, 20, &mut cache);
    assert!(second.contains("Context compressed"), "{second}");
    assert!(!second.contains("Compressing context"), "{second}");
    assert!(second.contains("8K → 2K"), "{second}");
    assert!(cache.hits >= hits_before);
}

#[test]
fn marker_lines_stay_bounded_for_hostile_fields() {
    let hostile = compact_row(json!({
        "type":"compact","origin":"manual","status":"failed",
        "tokensBefore": 10.7,
        "reason": "x".repeat(4096)
    }));
    let line = marker_line(&hostile, false).unwrap();
    let text = line_text(&line);
    assert!(text.chars().count() <= 260, "{}", text.chars().count());
    assert!(!text.contains('\n'));
    let mut view = View::default();
    view.rows = vec![hostile];
    let screen = render(&view, 40, 16);
    assert!(screen.contains("Context compression failed"));
}

#[test]
fn slash_completion_pane_is_drawn_by_presentation() {
    // presentation 只调用 completion 模块入口；候选与摘要都来自 commands 目录。
    let mut view = View::default();
    view.zh = true;
    view.rows = vec![json!({"kind":"assistantText","text":"body"})];
    view.editor.insert("/co");
    view.sync_completion();
    let screen = render(&view, 80, 24);
    assert!(screen.contains("/compact"), "completion pane is drawn");
    // 宽字符在 buffer 里与续行 cell 交替，按单个 zh 字符判定本地化摘要。
    assert!(screen.contains('缩'), "zh summary comes from the catalog");
    assert!(
        !screen.contains("Ask the runtime"),
        "en summary is not used"
    );
    // 选择器/审批打开时补全不绘制，避免抢走原交互。
    view.editor.clear();
    view.sync_completion();
    let screen = render(&view, 80, 24);
    assert!(!screen.contains("/compact"));
}
