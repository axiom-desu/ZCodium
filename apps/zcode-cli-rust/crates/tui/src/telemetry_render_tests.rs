//! MCP/usage 展示：真实字段、有界行数、ANSI/NO_COLOR（spec §3「展示」）。
#![allow(clippy::field_reassign_with_default)]

use crate::{
    client::QueryKind, client_reads::ReadReply, presentation::RenderCache, presentation::draw,
    presentation_status::composer_status, projection::View, telemetry, telemetry_render::mcp_lines,
};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::json;
use zcode_cli_core_api::RuntimeError;

fn view() -> View {
    let mut view = View::default();
    view.snapshot(&json!({"sessionId":"s","seq":0,"rows":{"window":[]},
        "control":{"canStop":false,"phase":"draft"},"config":{"mode":"build"},"pendingInteractions":[]}));
    view
}

fn line_text(line: &ratatui::text::Line<'_>) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

fn reply(
    view: &View,
    kind: QueryKind,
    result: Result<serde_json::Value, RuntimeError>,
) -> ReadReply {
    ReadReply {
        kind,
        session: view.session.clone(),
        generation: view.generation,
        result,
    }
}

/// MCP 空结果是无状态；错误保留 last known + 可见错误，不变成永绿。
#[tokio::test]
async fn mcp_empty_and_failure_are_reported_truthfully() {
    let mut view = view();
    let empty = reply(&view, QueryKind::McpStatus, Ok(json!({"statuses":{}})));
    telemetry::apply_reply(&mut view, empty);
    assert!(view.telemetry.mcp_servers.is_empty());
    assert!(view.telemetry.mcp_loaded);
    let text = mcp_lines(&view, 36)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("No MCP servers"));
    assert!(!text.contains("connected"));

    let statuses = reply(
        &view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":{
            "filesystem":{"status":"connected","transport":"stdio","toolCount":7},
            "broken":{"status":"failed","transport":"http","toolCount":0,
                "failureKind":"connection_timeout","error":"connect timeout"}
        }})),
    );
    telemetry::apply_reply(&mut view, statuses);
    assert_eq!(view.telemetry.mcp_servers.len(), 2);
    let failed = reply(
        &view,
        QueryKind::McpStatus,
        Err(RuntimeError::Fault {
            message: "mcp hub busy".into(),
            code: None,
        }),
    );
    telemetry::apply_reply(&mut view, failed);
    assert_eq!(view.telemetry.mcp_servers.len(), 2);
    assert_eq!(view.telemetry.mcp_error.as_deref(), Some("mcp hub busy"));
    let lines = mcp_lines(&view, 36);
    let text = lines.iter().map(line_text).collect::<Vec<_>>().join("\n");
    assert!(text.contains("filesystem"));
    assert!(text.contains("connect timeout"));
    assert!(text.contains("Refresh failed"));
    assert!(lines.iter().all(|line| line.width() <= 36));

    // 最多 5 行服务器：8 台时只画 5 条 + 更多计数。
    view.telemetry.mcp_servers = (0..8)
        .map(|index| telemetry::McpServer {
            name: format!("server-{index}"),
            status: "connected".into(),
            transport: "stdio".into(),
            tool_count: Some(1),
            failure_kind: None,
            error: None,
        })
        .collect();
    view.telemetry.mcp_total = 8;
    view.telemetry.mcp_connected = 8;
    let lines = mcp_lines(&view, 36);
    let rows = lines
        .iter()
        .map(line_text)
        .filter(|line| line.contains("server-"))
        .count();
    assert_eq!(rows, 5);
    assert!(lines.iter().all(|line| line.width() <= 36));
}

/// 缓存只存前 32 个细项；摘要与“更多”必须用完整 map 的真实总数，不能虚报 32。
#[test]
fn summary_and_remainder_use_the_real_total_beyond_the_cache() {
    let mut view = view();
    let mut statuses = serde_json::Map::new();
    for index in 0..40 {
        let status = if index == 0 {
            "failed"
        } else if index < 11 {
            "connected"
        } else {
            "disabled"
        };
        statuses.insert(
            format!("server-{index:02}"),
            json!({"status":status,"transport":"stdio","toolCount":1}),
        );
    }
    let reply = reply(
        &view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":statuses})),
    );
    telemetry::apply_reply(&mut view, reply);
    let lines = mcp_lines(&view, 40);
    let text = lines.iter().map(line_text).collect::<Vec<_>>().join("\n");
    assert!(text.contains("10/40"), "real connected/total: {text}");
    assert!(
        !text.contains("10/32"),
        "cached rows must not be the total: {text}"
    );
    assert!(
        text.contains("+35"),
        "remainder uses the real total: {text}"
    );
    assert!(!text.contains("server-32"), "only cached details are shown");
}

/// 缺失工具数是“未知”，不能渲染成 0；双语都不虚报。
#[test]
fn unknown_tool_count_is_not_rendered_as_zero() {
    let mut view = view();
    let reply = reply(
        &view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":{"fs":{"status":"connected","transport":"stdio"}}})),
    );
    telemetry::apply_reply(&mut view, reply);
    let text = mcp_lines(&view, 40)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!text.contains("0 tools"), "{text}");
    assert!(text.contains("stdio · ?"), "{text}");
    view.zh = true;
    let text = mcp_lines(&view, 40)
        .iter()
        .map(line_text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("stdio · ?"), "{text}");
    assert!(!text.contains("0 工具"), "{text}");
}

/// history read 即使回包也不在本模块假造数据，原样交给前端分流。
#[tokio::test]
async fn history_replies_are_passed_through_without_fake_state() {
    let mut view = view();
    let history = reply(
        &view,
        QueryKind::History { skip: 7 },
        Ok(json!({"rows":[{"text":"remembered"}]})),
    );
    telemetry::apply_reply(&mut view, history);
    assert!(view.notices.is_empty());
    assert!(view.telemetry.usage.is_none());
    assert!(view.editor.text().is_empty());
}

/// context badge 只认真实 `contextWindow`，不用累计 token 顶替；窄屏先丢 badge。
#[test]
fn context_badge_uses_real_context_window_only() {
    let mut view = view();
    view.state["usage"] = json!({
        "contextWindow": {"usedTokens": 12_300, "maxTokens": 200_000},
        "cumulative": {"inputTokens": 999_999, "outputTokens": 888_888}
    });
    let text = line_text(&composer_status(&view, 80));
    assert!(text.contains("12.3K (6%)"), "{text}");
    assert!(!text.contains("999999"), "{text}");
    let narrow = line_text(&composer_status(&view, 12));
    assert!(!narrow.contains("12.3K"), "{narrow}");
    // 只有 used、没有正 window：不给百分比。
    view.state["usage"] = json!({"contextWindow":{"usedTokens":2_400,"maxTokens":0}});
    let text = line_text(&composer_status(&view, 80));
    assert!(text.contains("2.4K"), "{text}");
    assert!(!text.contains('%'), "{text}");
    // 完全没有 contextWindow：不造 badge。
    view.state["usage"] = json!({"contextWindow":null,"cumulative":{"inputTokens":9}});
    let text = line_text(&composer_status(&view, 80));
    assert!(!text.contains('K'), "{text}");
}

/// 真实终端 buffer：no_color 下无 ANSI，badge 数值仍可见且不破行宽。
#[test]
fn telemetry_badge_renders_without_color_and_within_bounds() {
    let mut view = view();
    view.no_color = true;
    view.state["config"]["model"] = "model".into();
    view.state["config"]["provider"] = "provider".into();
    view.state["config"]["thought"] = "high".into();
    view.state["usage"] = json!({"contextWindow":{"usedTokens":12_300,"maxTokens":200_000}});
    let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
    terminal
        .draw(|frame| draw(frame, &view, &mut RenderCache::default(), 0))
        .unwrap();
    let cells = &terminal.backend().buffer().content;
    let screen = cells.iter().map(|cell| cell.symbol()).collect::<String>();
    assert!(screen.contains("12.3K"), "{screen}");
    assert!(!screen.contains('\u{1b}'));
    assert!(
        cells
            .iter()
            .all(|cell| cell.fg == ratatui::style::Color::Reset)
    );
    assert!(mcp_lines(&view, 36).iter().all(|line| line.width() <= 36));
}
