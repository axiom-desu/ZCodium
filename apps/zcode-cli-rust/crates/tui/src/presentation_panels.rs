use super::presentation_markdown::clean_terminal;
use crate::projection::View;
use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

const ACCENT: Color = Color::Rgb(125, 211, 252);
const TEXT: Color = Color::Rgb(229, 231, 235);
const MUTED: Color = Color::Rgb(148, 163, 184);

pub(super) const LOGO: [&str; 6] = [
    "███████╗ ██████╗ ██████╗ ██████╗ ██╗██╗   ██╗███╗   ███╗",
    "   ███╔╝██╔════╝██╔═══██╗██╔══██╗██║██║   ██║████╗ ████║",
    "  ███╔╝ ██║     ██║   ██║██║  ██║██║██║   ██║██╔████╔██║",
    " ███╔╝  ██║     ██║   ██║██║  ██║██║██║   ██║██║╚██╔╝██║",
    "███████╗╚██████╗╚██████╔╝██████╔╝██║╚██████╔╝██║ ╚═╝ ██║",
    "╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝ ╚═╝     ╚═╝",
];

pub(super) fn draw_sidebar(frame: &mut Frame<'_>, area: Rect, view: &View) {
    frame.render_widget(
        Block::default().style(Style::default().bg(Color::Rgb(22, 27, 34))),
        area,
    );
    let inner = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(8), Constraint::Min(3)])
        .split(area);
    let logo = ["╭── ZCODIUM ──╮", "│  Rust CLI  │", "╰────────────╯"];
    let logo = logo
        .iter()
        .map(|line| {
            Line::from(Span::styled(
                *line,
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ))
        })
        .collect::<Vec<_>>();
    frame.render_widget(
        Paragraph::new(logo)
            .block(Block::default().borders(Borders::ALL).title(" ZCODIUM "))
            .wrap(Wrap { trim: true }),
        inner[0],
    );
    let ws = &view.directory;
    let status = if view.busy() {
        view.text("Running", "运行中")
    } else {
        view.text("Ready", "就绪")
    };
    let content = format!(
        "{}\n{}  {}\n{}     {}\n{}    {}\n{} {}\n{}   {}\n\n{}",
        view.text("Rust-native terminal", "Rust 原生终端"),
        view.text("Session", "会话"),
        field_str(&view.session),
        view.text("Mode", "模式"),
        clean_terminal(view.mode()),
        view.text("Model", "模型"),
        field(&view.state["config"]["model"]),
        view.text("Workspace", "工作区"),
        field_str(ws),
        view.text("Status", "状态"),
        status,
        view.text("Missing fields shown as —", "缺失字段显示为 —")
    );
    frame.render_widget(
        Paragraph::new(clean_terminal(&content))
            .style(Style::default().fg(TEXT))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(MUTED))
                    .title(view.text(" Context ", " 上下文 ")),
            )
            .wrap(Wrap { trim: true }),
        inner[1],
    );
}

pub(super) fn draw_selector(
    frame: &mut Frame<'_>,
    bounds: Rect,
    selector: &crate::selector::Selector,
) {
    if bounds.width < 8 || bounds.height < 4 {
        return;
    }
    let width = bounds.width.saturating_sub(8).clamp(1, 72);
    let height = bounds
        .height
        .saturating_sub(6)
        .min(selector.options.len() as u16 + 4)
        .max(3);
    let popup = Rect::new(
        bounds.x + (bounds.width - width) / 2,
        bounds.y + (bounds.height - height) / 2,
        width,
        height,
    );
    let choices = selector
        .options
        .iter()
        .enumerate()
        .skip(
            selector
                .selected
                .saturating_sub(height.saturating_sub(3) as usize),
        )
        .take(height.saturating_sub(2) as usize)
        .map(|(i, (_, label))| {
            Line::from(Span::styled(
                format!(
                    "{} {}",
                    if i == selector.selected { "›" } else { " " },
                    clean_terminal(label)
                ),
                if i == selector.selected {
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(TEXT)
                },
            ))
        })
        .collect::<Vec<_>>();
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Block::default().style(Style::default().bg(Color::Rgb(22, 27, 34))),
        popup,
    );
    frame.render_widget(
        Paragraph::new(choices).block(
            Block::default()
                .borders(Borders::ALL)
                .title(clean_terminal(&selector.title)),
        ),
        popup,
    );
}
fn field(value: &serde_json::Value) -> String {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(clean_terminal)
        .unwrap_or_else(|| "—".to_owned())
}
fn field_str(value: &str) -> String {
    if value.is_empty() {
        "—".to_owned()
    } else {
        clean_terminal(value)
    }
}
