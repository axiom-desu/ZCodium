#![allow(clippy::field_reassign_with_default)]

use crate::{
    presentation::{RenderCache, draw},
    projection::View,
};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::json;

fn render(view: &View, width: u16, height: u16, cache: &mut RenderCache) -> String {
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

#[test]
fn layouts_survive_wide_narrow_and_tiny_buffers() {
    let mut view = View::default();
    view.state = json!({"config":{"workspacePath":"/work","model":"m","mode":"build"}});
    view.sidebar = true;
    view.directory = "/work".into();
    let mut cache = RenderCache::default();
    let wide = render(&view, 150, 40, &mut cache);
    assert!(wide.contains("ZCodium"));
    assert!(wide.contains("Status"));
    assert!(wide.contains("/work"));
    let narrow = render(&view, 80, 24, &mut cache);
    // 输入框标题跟随 permission mode，空输入显示提示词（与 TS TUI 一致）。
    assert!(narrow.contains("Type a prompt") || narrow.contains("输入提示词"));
    view.sidebar_overlay = true;
    assert!(render(&view, 80, 24, &mut cache).contains("Status"));
    let _ = render(&view, 1, 1, &mut cache);
}

#[test]
fn markdown_tool_cards_and_code_whitespace_are_rendered() {
    let mut view = View::default();
    view.rows = vec![
        json!({"kind":"assistantText","text":"# Heading\n- item\n**bold**\n```\n  x\n\n```"}),
        json!({"kind":"toolCall","toolName":"Read","status":"failed","inputText":"{\n  \"path\": \"x\"\n}","error":{"message":"bad"},"output":{"display":{"kind":"file_diff","structuredPatch":[{"lines":["-old","+new"]}]}}}),
    ];
    let mut cache = RenderCache::default();
    let content = render(&view, 100, 35, &mut cache);
    assert!(content.contains("Heading"));
    assert!(content.contains("Read"));
    assert!(content.contains("failed"));
    assert!(content.contains("  x"));
    assert!(content.contains("bad"));
    assert!(content.contains("-old"));
    assert!(content.contains("+new"));
}

#[test]
fn composer_keeps_unicode_cursor_visible_and_cache_invalidates() {
    let mut view = View::default();
    view.editor.insert("你🙂\nlong line");
    let mut cache = RenderCache::default();
    // 欢迎页不走缓存，所以先放入一条正文再验证缓存命中/失效。
    view.rows = vec![json!({"kind":"assistantText","text":"cached row"})];
    let initial = render(&view, 42, 12, &mut cache);
    assert!(initial.contains("long line"));
    let first = cache.hits;
    let _ = render(&view, 42, 12, &mut cache);
    assert!(cache.hits > first);
    view.editor.insert(" next");
    let before = cache.hits;
    let _ = render(&view, 42, 12, &mut cache);
    assert_eq!(cache.hits, before + 1);
    view.seq += 1;
    let before_update = cache.hits;
    let _ = render(&view, 42, 12, &mut cache);
    assert_eq!(cache.hits, before_update);
    let _ = render(&view, 12, 4, &mut cache);
}

#[test]
fn equal_sequence_reset_and_latest_history_invalidate_and_bound_cache() {
    let mut view = View::default();
    let snapshot = |text: &str| json!({"sessionId":"s","seq":4,"rows":{"window":[{"kind":"assistantText","text":text}]}});
    let mut cache = RenderCache::default();
    view.snapshot(&snapshot("before-reset"));
    assert!(render(&view, 80, 20, &mut cache).contains("before-reset"));
    view.snapshot(&snapshot("after-reset"));
    let frame = render(&view, 80, 20, &mut cache);
    assert!(frame.contains("after-reset"));
    assert!(!frame.contains("before-reset"));
    let rows = (0..100)
        .map(|i| json!({"kind":"assistantText","text":format!("row-{i} {}","x".repeat(16000))}))
        .collect::<Vec<_>>();
    view.snapshot(&json!({"sessionId":"s","seq":4,"rows":{"window":rows}}));
    let _ = render(&view, 8, 8, &mut cache);
    assert!(crate::presentation_text::bytes(&cache.lines) <= crate::projection::MAX_RENDER_BYTES);
    assert!(cache.lines.len() <= 32768);
    let _ = render(&view, 100, 24, &mut cache);
    assert!(
        cache
            .lines
            .iter()
            .any(|l| l.spans.iter().any(|s| s.content.contains("row-99")))
    );
}

#[test]
fn plan_is_derived_and_approval_empty_input_never_approves() {
    let mut view = View::default();
    view.state = json!({"config":{"mode":"build","planEnabled":true}});
    assert_eq!(view.mode(), "plan");
    view.state["config"]["planEnabled"] = false.into();
    assert_eq!(view.mode(), "build");
    let permission = json!({"kind":"permission","payload":{"options":[{"optionId":"allowOnce"},{"optionId":"deny"}]}});
    assert!(crate::interactions::answer(&permission, "").is_err());
    let question = json!({"payload":{"input":{"questions":[{"question":"pick"}]}}});
    assert!(crate::interactions::answer(&question, "").is_err());
    assert!(crate::interactions::answer(&question, "A").is_ok());
    let mut lines = Vec::new();
    crate::presentation_markdown::markdown_into(&mut lines, "  **literal**\n```\n\tx", true);
    assert!(
        lines
            .iter()
            .any(|l| l.spans.iter().any(|s| s.content.contains("**literal**")))
    );
    assert!(
        lines
            .iter()
            .any(|l| l.spans.iter().any(|s| s.content.contains("    x")))
    );
    for width in [1, 2, 8, 40, 80, 140] {
        for height in [1, 2, 4, 20] {
            let _ = render(&view, width, height, &mut RenderCache::default());
        }
    }
}

#[test]
fn no_color_and_tiny_unicode_cursor_stay_inside_terminal() {
    let mut view = View::default();
    view.no_color = true;
    view.sidebar_overlay = true;
    view.editor.insert("你\t🙂abcdefghijklmnop");
    for (width, height) in [(1, 1), (2, 4), (8, 4), (40, 12), (140, 30)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| draw(frame, &view, &mut RenderCache::default(), 0))
            .unwrap();
        let pos = terminal.get_cursor_position().unwrap();
        assert!(pos.x < width && pos.y < height);
        for cell in &terminal.backend().buffer().content {
            assert_eq!(cell.fg, ratatui::style::Color::Reset);
            assert_eq!(cell.bg, ratatui::style::Color::Reset);
        }
    }
}

#[test]
fn ansi_and_osc_sequences_do_not_reach_buffer() {
    let mut view = View::default();
    view.rows = vec![
        json!({"kind":"assistantText","text":"safe\u{001b}[31m red\u{001b}]0;title\u{0007}"}),
        json!({"kind":"toolCall","toolName":"Read","status":"done\u{001b}]0;status-title\u{0007}"}),
    ];
    let mut cache = RenderCache::default();
    let content = render(&view, 70, 20, &mut cache);
    assert!(content.contains("safe"));
    assert!(!content.contains("\u{001b}"));
    assert!(!content.contains("title"));
}

fn screen_rows(
    view: &View,
    width: u16,
    height: u16,
    frame_ms: u64,
) -> (Vec<String>, Vec<Vec<ratatui::style::Color>>) {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    let mut cache = RenderCache::default();
    terminal
        .draw(|frame| draw(frame, view, &mut cache, frame_ms))
        .unwrap();
    let buffer = terminal.backend().buffer();
    let mut rows = Vec::new();
    let mut colors = Vec::new();
    for y in 0..height {
        let mut line = String::new();
        let mut row = Vec::new();
        for x in 0..width {
            let cell = &buffer.content[(y * width + x) as usize];
            line.push_str(cell.symbol());
            row.push(cell.fg);
        }
        rows.push(line);
        colors.push(row);
    }
    (rows, colors)
}

fn mark_rows(rows: &[String]) -> Vec<usize> {
    rows.iter()
        .enumerate()
        .filter(|(_, line)| line.contains("██"))
        .map(|(index, _)| index)
        .collect()
}

#[test]
fn welcome_mark_is_centered_and_shimmers() {
    let (rows, colors) = screen_rows(&View::default(), 150, 40, 0);
    let mark = mark_rows(&rows);
    // 第六行是纯 ╚ 收边，不含 '█'，所以含实心块的行是五行，标识整体仍是六行。
    assert_eq!(
        mark.len(),
        5,
        "welcome mark keeps its block rows (got {}): {rows:#?}",
        mark.len()
    );
    assert!(
        rows[mark[mark.len() - 1] + 1].contains("╚══════╝"),
        "mark keeps its closing row"
    );
    assert!(
        mark[0] >= 3,
        "mark starts below the frame border: {}",
        mark[0]
    );
    let first: Vec<char> = rows[mark[0]].chars().collect();
    let start = first.iter().position(|c| *c == '█').expect("block glyph");
    let end = first.iter().rposition(|c| *c == '█').unwrap_or(start) + 1;
    let inner_left = start.saturating_sub(1);
    let inner_right = 150usize.saturating_sub(2).saturating_sub(end);
    assert!(
        inner_left >= 5,
        "mark is inset from the left edge: {inner_left}"
    );
    assert!(
        inner_left.abs_diff(inner_right) <= 3,
        "mark is horizontally centered: left={inner_left} right={inner_right}"
    );
    let subtitle = rows
        .iter()
        .position(|line| line.contains("/model"))
        .expect("subtitle is rendered");
    let subtitle_start = rows[subtitle]
        .chars()
        .collect::<Vec<_>>()
        .iter()
        .position(|c| *c == 'R')
        .unwrap_or(0);
    let subtitle_inner_left = subtitle_start.saturating_sub(1);
    assert!(
        subtitle_inner_left.abs_diff(inner_left) <= 3,
        "subtitle is centered under the mark: {subtitle_inner_left}"
    );
    let (_, later_colors) = screen_rows(&View::default(), 150, 40, 450);
    let early_row = &colors[mark[0]];
    let later_row = &later_colors[mark[0]];
    assert!(
        early_row.iter().zip(later_row.iter()).any(|(a, b)| a != b),
        "welcome mark shimmer advances with time"
    );
}

#[test]
fn welcome_fallback_and_composer_titles_follow_mode() {
    let (rows, _) = screen_rows(&View::default(), 40, 14, 0);
    let fallback = rows
        .iter()
        .position(|line| line.contains("ZCODIUM · Rust"))
        .expect("narrow welcome fallback is rendered");
    let fallback_chars: Vec<char> = rows[fallback].chars().collect();
    let start = fallback_chars.iter().position(|c| *c == 'Z').unwrap_or(0);
    let end = start + "ZCODIUM · Rust".chars().count();
    let inner_left = start.saturating_sub(1);
    let inner_right = 40usize.saturating_sub(2).saturating_sub(end);
    assert!(
        inner_left >= 3,
        "narrow fallback stays centered: {inner_left}"
    );
    assert!(
        inner_left.abs_diff(inner_right) <= 2,
        "narrow fallback is centered: {inner_left}/{inner_right}"
    );

    let mut view = View::default();
    view.state = json!({"config":{"mode":"build"}});
    view.state["control"] = json!({});
    let (rows, _) = screen_rows(&view, 100, 24, 0);
    assert!(
        rows.iter().any(|line| line.contains(" Build ")),
        "composer title follows the permission mode"
    );
    assert!(
        rows.iter().any(|line| line.contains("Type a prompt")),
        "empty composer shows the prompt placeholder"
    );

    view.editor.insert("hello");
    let (rows, _) = screen_rows(&view, 100, 24, 0);
    assert!(
        !rows.iter().any(|line| line.contains("Type a prompt")),
        "placeholder disappears once the composer has text"
    );
    assert!(rows.iter().any(|line| line.contains("hello")));
}

fn sidebar_view() -> View {
    let mut view = View::default();
    view.sidebar = true;
    view.directory = "/work/dir".into();
    view.state = json!({
        "control": {"phase": "completedSuccess", "canStop": false, "stopState": "idle", "lastError": null},
        "config": {"mode": "build", "model": "m1"},
        "subagents": {"revision": 1, "childSessionIds": ["child-a", "child-b"], "running": ["child-a", "child-b"], "endedTotal": 3},
        "plan": {"items": [
            {"id": "t1", "content": "first done", "status": "completed"},
            {"id": "t2", "content": "second active", "status": "inProgress"},
            {"id": "t3", "content": "third pending", "status": "pending"}
        ]}
    });
    view.rows = vec![
        json!({"kind":"toolCall","toolName":"Write","status":"done","output":{"display":{"kind":"file_diff","filePath":"/work/dir/a.rs","additions":3,"deletions":1,"structuredPatch":[]}}}),
        json!({"kind":"toolCall","toolName":"Write","status":"done","output":{"display":{"kind":"file_diff","filePath":"/work/dir/a.rs","additions":2,"deletions":1,"structuredPatch":[]}}}),
        json!({"kind":"toolCall","toolName":"Write","status":"done","output":{"display":{"kind":"file_diff","filePath":"/work/dir/b.rs","additions":7,"deletions":0,"structuredPatch":[]}}}),
    ];
    view
}

#[test]
fn sidebar_matches_ts_sections_from_real_state() {
    let view = sidebar_view();
    let (rows, _) = screen_rows(&view, 150, 40, 0);
    let text = rows.join("\n");
    assert!(
        text.contains("ZCodium Rust 0.1.0"),
        "product header: {text}"
    );
    assert!(text.contains("Status"), "status section");
    assert!(
        text.contains("Subagents (2)"),
        "running subagents counted: {text}"
    );
    assert!(text.contains("Running 2"), "running line");
    assert!(text.contains("ended 3"), "ended total");
    assert!(text.contains("child-a"), "child session listed");
    assert!(text.contains("Modified Files"), "modified files section");
    assert!(text.contains("a.rs"), "first changed file");
    assert!(text.contains("+5 -2"), "counts aggregate per path: {text}");
    assert!(text.contains("b.rs"), "second changed file");
    assert!(text.contains("Todos"), "todos section");
    assert!(text.contains("Progress 1/3"), "todo progress");
    assert!(
        text.contains("first done") && text.contains("second active"),
        "todo rows"
    );
    assert!(text.contains("/work/dir"), "workspace footer");
    assert!(!text.contains("MCP"), "no fabricated MCP section");
}

#[test]
fn sidebar_empty_states_are_explicit_and_bounded() {
    let mut view = View::default();
    view.sidebar = true;
    let (rows, _) = screen_rows(&view, 150, 30, 0);
    let text = rows.join("\n");
    assert!(
        text.contains("No subagents yet."),
        "empty subagents: {text}"
    );
    assert!(text.contains("No file changes yet."), "empty files");
    assert!(text.contains("No todos yet."), "empty todos");

    // 超长内容必须截断，不能把侧栏撑开或换行挤进对话区。
    let mut long = sidebar_view();
    long.rows = vec![
        json!({"kind":"toolCall","toolName":"Write","status":"done","output":{"display":{"kind":"file_diff","filePath":format!("/work/dir/{}","x".repeat(200)),"additions":1,"deletions":0,"structuredPatch":[]}}}),
    ];
    let (rows, _) = screen_rows(&long, 150, 30, 0);
    assert!(rows.iter().all(|line| line.chars().count() <= 150));
    let sidebar_line = rows
        .iter()
        .find(|line| line.contains("…/dir/xxx"))
        .expect("long path is compressed to keep the file name readable");
    assert!(sidebar_line.chars().count() <= 150);
}
