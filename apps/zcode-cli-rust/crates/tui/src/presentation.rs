pub(crate) use super::presentation_welcome::is_welcome;
use super::{
    presentation_markdown::{clean_terminal, markdown_into, tool_card},
    presentation_markers::marker_line,
    presentation_panels::{draw_selector_localized, draw_sidebar},
    presentation_status::composer_status,
    presentation_text,
    presentation_welcome::draw_welcome,
};
use crate::{interactions, projection::View};
use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

pub(crate) const ACCENT: Color = Color::Rgb(125, 211, 252);
pub(crate) const TEXT: Color = Color::Rgb(229, 231, 235);
pub(crate) const MUTED: Color = Color::Rgb(148, 163, 184);
const GREEN: Color = Color::Rgb(134, 239, 172);
const GOLD: Color = Color::Rgb(251, 191, 36);
#[derive(Default)]
pub(crate) struct RenderCache {
    key: Option<(u64, u64, String, u16, bool)>,
    pub(crate) lines: Vec<Line<'static>>,
    pub(crate) hits: usize,
}

pub(crate) fn draw(frame: &mut Frame<'_>, view: &View, cache: &mut RenderCache, frame_ms: u64) {
    let bounds = frame.area();
    if bounds.width == 0 || bounds.height == 0 {
        return;
    }
    frame.render_widget(
        Block::default().style(Style::default().bg(Color::Rgb(15, 20, 25))),
        bounds,
    );
    let wide = bounds.width > 120 && view.sidebar;
    let overlay_visible = !wide && view.sidebar_overlay && bounds.width >= 16 && bounds.height >= 8;
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(if wide {
            [Constraint::Min(1), Constraint::Length(42)]
        } else {
            [Constraint::Percentage(100), Constraint::Length(0)]
        })
        .split(bounds);
    let editor_height = if bounds.height >= 10 {
        (view.editor.text().lines().count().clamp(1, 7) + 2) as u16
    } else {
        1
    };
    let help_height = if bounds.height >= 12 && view.interaction().is_some() {
        6
    } else {
        u16::from(bounds.height >= 5)
    };
    let status_height = u16::from(bounds.height >= 6);
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(1),
            Constraint::Length(help_height),
            Constraint::Length(editor_height),
            Constraint::Length(status_height),
        ])
        .split(cols[0]);
    let bw = areas[0].width.saturating_sub(2).max(1);
    let bh = areas[0].height.saturating_sub(2) as usize;
    if is_welcome(view) {
        draw_welcome(frame, areas[0], view, frame_ms, bh);
    } else {
        let body = cached_lines(view, bw, cache);
        let max_scroll = body.len().saturating_sub(bh);
        let start = if view.follow {
            max_scroll
        } else {
            view.scroll.min(max_scroll)
        };
        frame.render_widget(
            Paragraph::new(
                body.iter()
                    .skip(start)
                    .take(bh)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
            .style(Style::default().fg(TEXT))
            .block(transcript_block()),
            areas[0],
        );
    }
    if wide {
        draw_sidebar(frame, cols[1], view);
    }
    if help_height > 0 {
        let help = if let Some(s) = &view.selector {
            format!(
                "{} · {}",
                s.title,
                view.text(
                    "↑/↓ Enter select · Esc cancel",
                    "↑/↓ 选择 · Enter 确认 · Esc 取消"
                )
            )
        } else if let Some(interaction) = view.interaction() {
            interactions::panel(interaction, view.zh)
        } else {
            view.text(
                "Enter send · Alt/Shift+Enter newline · Ctrl-X,B sidebar · /help",
                "Enter 发送 · Alt/Shift+Enter 换行 · Ctrl-X,B 侧栏 · /help",
            )
            .into()
        };
        let mut widget = Paragraph::new(clean_terminal(&help))
            .style(Style::default().fg(MUTED))
            .wrap(Wrap { trim: false });
        if help_height > 2 {
            widget = widget.block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(GREEN))
                    .title(view.text(" Awaiting your decision ", " 等待您的决定 ")),
            );
        }
        frame.render_widget(widget, areas[1]);
    }
    let area = areas[2];
    if area.width > 0 && area.height > 0 {
        let bordered = area.width > 2 && area.height > 2;
        let inset = u16::from(bordered);
        let iw = area.width.saturating_sub(inset * 2).max(1) as usize;
        let ih = area.height.saturating_sub(inset * 2).max(1) as usize;
        let (line, col) = view.editor.cursor_line_col();
        let scroll_y = line.saturating_sub(ih.saturating_sub(1));
        let scroll_x = col.saturating_sub(iw.saturating_sub(1));
        let text =
            presentation_text::input_window(&clean_terminal(view.editor.text()), line, ih, col, iw);
        let mut widget = Paragraph::new(clean_terminal(&text)).style(Style::default().fg(TEXT));
        if bordered {
            widget = widget.block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(ACCENT))
                    .title(format!(" {} ", mode_title(view))),
            );
        }
        frame.render_widget(widget, area);
        if view.editor.text().is_empty() && bordered {
            // 与 TS 输入框一致：空闲显示输入提示，运行中显示排队提示。
            let placeholder = view.text(
                if view.busy() {
                    "Type to queue input"
                } else {
                    "Type a prompt"
                },
                if view.busy() {
                    "输入内容将排队"
                } else {
                    "输入提示词"
                },
            );
            frame.render_widget(
                Paragraph::new(clean_terminal(placeholder)).style(Style::default().fg(MUTED)),
                ratatui::layout::Rect::new(area.x + inset, area.y + inset, iw as u16, 1),
            );
        }
        if !overlay_visible {
            frame.set_cursor_position((
                area.x + inset + col.saturating_sub(scroll_x).min(iw - 1) as u16,
                area.y + inset + line.saturating_sub(scroll_y).min(ih - 1) as u16,
            ));
        }
    }
    if status_height > 0 {
        // 输入框下方只显示 model / provider / thought，与 TS app-input-status 同层次；
        // session/运行状态仍由侧栏 Status 与输入占位提示承担。
        frame.render_widget(
            Paragraph::new(composer_status(view, areas[3].width)),
            areas[3],
        );
    }
    if overlay_visible {
        let width = bounds.width.min(42);
        let overlay =
            ratatui::layout::Rect::new(bounds.right() - width, bounds.y, width, bounds.height);
        frame.render_widget(ratatui::widgets::Clear, overlay);
        draw_sidebar(frame, overlay, view);
    }
    // 输入补全面板画在选择器之前，由 completion 模块自己负责边界与清屏。
    crate::completion::draw(frame, bounds, &view.completion, view.zh);
    if let Some(selector) = &view.selector {
        // 选择器过滤/空结果提示跟随 view.zh，与原 typed choice 保存同一份选项。
        draw_selector_localized(frame, bounds, selector, view.zh);
    }
    if view.no_color {
        for cell in &mut frame.buffer_mut().content {
            cell.set_fg(Color::Reset);
            cell.set_bg(Color::Reset);
        }
    }
}
pub(crate) fn transcript_block() -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACCENT))
        .title(" ZCodium Rust ")
}

fn mode_title(view: &View) -> String {
    let mode = view.mode();
    let mut chars = mode.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => mode.to_owned(),
    }
}

fn cached_lines<'a>(view: &View, width: u16, cache: &'a mut RenderCache) -> &'a [Line<'static>] {
    let key = (
        view.display_revision,
        view.seq,
        view.session.clone(),
        width,
        view.zh,
    );
    if cache.key.as_ref() == Some(&key) {
        cache.hits += 1;
    } else {
        cache.lines = presentation_text::wrap(render_rows(view), width as usize);
        cache.key = Some(key);
    }
    &cache.lines
}
pub(crate) fn render_rows(view: &View) -> Vec<Line<'static>> {
    let budget = crate::projection::MAX_RENDER_BYTES;
    let mut alerts = Vec::new();
    for notice in &view.notices {
        alerts.push(Line::from(Span::styled(
            clean_terminal(notice),
            Style::default().fg(GOLD),
        )));
    }
    if let Some(error) = view.state["control"]["lastError"]["message"].as_str() {
        alerts.push(Line::from(Span::styled(
            format!(
                "Error: {}",
                clean_terminal(&error.chars().take(16384).collect::<String>())
            ),
            Style::default().fg(Color::Rgb(252, 165, 165)),
        )));
    }
    if view.state["control"]["phase"] == "completedInterrupted" {
        alerts.push(Line::raw(view.text("Turn cancelled", "运行已取消")));
    }
    let mut alert_used = 0;
    let mut selected_alerts = Vec::new();
    for line in alerts.into_iter().rev() {
        let cost = presentation_text::bytes(std::slice::from_ref(&line));
        if alert_used + cost <= budget / 4 {
            alert_used += cost;
            selected_alerts.push(line);
        }
    }
    let mut chunks = Vec::new();
    let mut used = alert_used;
    // 先选择最新完整行再做拼接，不能先解析32MiB历史后才删旧行，更不能留下旧历史挤掉新回复。
    for row in view.rows.iter().rev() {
        let mut chunk = Vec::new();
        let kind = row["kind"].as_str().unwrap_or("");
        let (label, color) = match kind {
            "userQuery" => (view.text("You", "你"), ACCENT),
            "assistantText" => (view.text("Assistant", "助手"), GREEN),
            "reasoning" => (view.text("Thinking", "思考"), GOLD),
            _ => ("", MUTED),
        };
        if !label.is_empty() {
            chunk.push(Line::from(Span::styled(
                label.to_owned(),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            )));
        }
        if kind == "timelineMarker" {
            // 只展示 core/domain 真实写入的 marker 字段；未知 marker 不占一行。
            // 旧实现先在分支内补一个空行、循环末尾再补一个，marker 后出现双空行；
            // 这里只用统一的块尾空行，未知 marker 直接跳过整块。
            let Some(line) = marker_line(row, view.zh) else {
                continue;
            };
            chunk.push(line);
        } else if kind == "toolCall" {
            tool_card(&mut chunk, row);
        } else {
            markdown_into(
                &mut chunk,
                row["text"].as_str().unwrap_or(""),
                kind == "userQuery",
            );
        }
        chunk.push(Line::raw(""));
        let cost = presentation_text::bytes(&chunk);
        if used + cost > budget {
            break;
        }
        used += cost;
        chunks.push(chunk);
    }
    let mut lines = Vec::new();
    for chunk in chunks.into_iter().rev() {
        lines.extend(chunk);
    }
    lines.extend(selected_alerts.into_iter().rev());
    lines
}
