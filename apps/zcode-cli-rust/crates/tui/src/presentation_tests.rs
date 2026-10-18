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
    terminal.draw(|frame| draw(frame, view, cache)).unwrap();
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
    assert!(wide.contains("ZCODIUM"));
    assert!(wide.contains("Context"));
    assert!(wide.contains("/work"));
    let narrow = render(&view, 80, 24, &mut cache);
    assert!(narrow.contains("Message") || narrow.contains("输入"));
    view.sidebar_overlay = true;
    assert!(render(&view, 80, 24, &mut cache).contains("Context"));
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
            .draw(|frame| draw(frame, &view, &mut RenderCache::default()))
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
