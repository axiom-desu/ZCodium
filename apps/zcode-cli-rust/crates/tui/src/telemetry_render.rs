//! 侧栏 MCP 分区渲染（spec cli-rust-tui-workbench §3「展示」）。
//!
//! 只读 `View.telemetry`：不查询、不连接、不解析历史。空结果是“无状态”，
//! 刷新失败保留 last known + 可见错误，未连接不能画成绿色。
use super::presentation::{ACCENT, MUTED, TEXT};
use super::presentation_markdown::clean_terminal;
use super::telemetry::{MAX_SERVER_ROWS, McpServer};
use crate::projection::View;
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};

const GREEN: Color = Color::Rgb(134, 239, 172);
const DANGER: Color = Color::Rgb(252, 165, 206);
const STATUS_WIDTH: usize = 10;
const META_WIDTH: usize = 14;
const MIN_NAME_WIDTH: usize = 4;

/// 侧栏 MCP 分区：标题 + 汇总 + 最多 5 行服务器 + 错误/更多提示。
pub(crate) fn mcp_lines(view: &View, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if width == 0 {
        return lines;
    }
    lines.push(Line::from(Span::styled(
        "MCP",
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
    )));
    let telemetry = &view.telemetry;
    let summary = format!(
        "{} {}/{}",
        view.text("Servers", "服务器"),
        telemetry.mcp_connected,
        telemetry.mcp_total
    );
    lines.push(body(&summary, TEXT, width));
    if telemetry.mcp_total == 0 {
        let (message, color) = if telemetry.mcp_loading {
            (
                view.text("Loading MCP status…", "正在加载 MCP 状态…"),
                MUTED,
            )
        } else if telemetry.mcp_error.is_some() {
            (
                view.text("MCP status unavailable.", "MCP 状态不可用。"),
                DANGER,
            )
        } else {
            (
                view.text("No MCP servers configured.", "未配置 MCP 服务器。"),
                MUTED,
            )
        };
        lines.push(body(message, color, width));
        if let Some(error) = &telemetry.mcp_error {
            lines.push(body(error, DANGER, width));
        }
        return lines;
    }
    let mut failure = None;
    for server in telemetry.mcp_servers.iter().take(MAX_SERVER_ROWS) {
        if failure.is_none() && server.status == "failed" {
            // 只保留第一条失败详情，避免错误文本挤满侧栏。
            failure = server.error.clone().or_else(|| server.failure_kind.clone());
        }
        lines.push(server_line(view, server, width));
    }
    if telemetry.mcp_total > MAX_SERVER_ROWS {
        // “更多”用完整 map 的真实总数，不把 32 个缓存细项当成全部。
        lines.push(body(
            &format!("+{}", telemetry.mcp_total - MAX_SERVER_ROWS),
            MUTED,
            width,
        ));
    }
    if let Some(failure) = failure {
        lines.push(body(&failure, DANGER, width));
    }
    if let Some(error) = &telemetry.mcp_error {
        lines.push(body(
            &format!("{} {error}", view.text("Refresh failed:", "刷新失败：")),
            DANGER,
            width,
        ));
    }
    lines
}

fn server_line(view: &View, server: &McpServer, width: usize) -> Line<'static> {
    let label = status_label(view, &server.status);
    // 缺失工具数是“未知”，不画成 0 个工具（用 `?` 占位，不编造数字）。
    let tools = match server.tool_count {
        Some(count) => format!("{count} {}", view.text("tools", "工具")),
        None => "?".to_owned(),
    };
    let meta = format!("{} · {tools}", clean_terminal(&server.transport));
    let meta = truncate(&meta, META_WIDTH);
    let name_budget = width
        .saturating_sub(STATUS_WIDTH + 1 + cells(&meta) + 1)
        .max(MIN_NAME_WIDTH);
    let name = truncate(&clean_terminal(&server.name), name_budget);
    let status = truncate(&label, STATUS_WIDTH);
    let padding = STATUS_WIDTH.saturating_sub(cells(&status));
    let plain = format!("{status}{} {name} {meta}", " ".repeat(padding));
    if cells(&plain) > width {
        // 单行预算：超出宽度时按显示单元截断，保证不会顶掉侧栏边框。
        return body(&plain, TEXT, width);
    }
    Line::from(vec![
        Span::styled(
            format!("{status}{}", " ".repeat(padding)),
            Style::default().fg(status_color(&server.status)),
        ),
        Span::styled(format!(" {name} "), Style::default().fg(TEXT)),
        Span::styled(meta, Style::default().fg(MUTED)),
    ])
}

fn status_label(view: &View, status: &str) -> String {
    match status {
        "connected" => view.text("connected", "已连接"),
        "disabled" => view.text("disabled", "已禁用"),
        "failed" => view.text("failed", "失败"),
        "connecting" => view.text("connecting", "连接中"),
        "untrusted" => view.text("untrusted", "未信任"),
        other => other,
    }
    .to_owned()
}

fn status_color(status: &str) -> Color {
    match status {
        "connected" => GREEN,
        "failed" => DANGER,
        "connecting" => ACCENT,
        _ => MUTED,
    }
}

fn body(value: &str, color: Color, width: usize) -> Line<'static> {
    Line::from(Span::styled(
        truncate(&clean_terminal(value), width),
        Style::default().fg(color),
    ))
}

fn cells(value: &str) -> usize {
    Line::raw(value).width()
}

/// 按显示宽度截断并补 `…`；CJK/emoji 不会被拆成半个字。
fn truncate(value: &str, width: usize) -> String {
    if cells(value) <= width {
        return value.to_owned();
    }
    let limit = width.saturating_sub(1);
    let mut out = String::new();
    let mut used = 0;
    for grapheme in Line::raw(value).styled_graphemes(Style::default()) {
        let grapheme_width = Line::raw(grapheme.symbol).width();
        if used + grapheme_width > limit {
            break;
        }
        out.push_str(grapheme.symbol);
        used += grapheme_width;
    }
    if width > 0 {
        out.push('…');
    }
    out
}
