//! `@file` 建议面板渲染；边界、8 行窗口与 NO_COLOR 继承都在这里。
use crate::file_mentions::FileMentions;
use crate::presentation_markdown::clean_terminal;
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
};

const MAX_WIDTH: u16 = 72;

fn no_color() -> bool {
    std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty())
}

/// 有界建议面板；`NO_COLOR` 从父进程环境继承，面板只做无颜色渲染。
pub(crate) fn draw(frame: &mut Frame<'_>, bounds: Rect, mentions: &FileMentions, zh: bool) {
    draw_with_color(frame, bounds, mentions, zh, !no_color());
}

pub(crate) fn draw_with_color(
    frame: &mut Frame<'_>,
    bounds: Rect,
    mentions: &FileMentions,
    zh: bool,
    color: bool,
) {
    if !mentions.visible() || bounds.width < 12 || bounds.height < 4 {
        return;
    }
    let mut lines: Vec<Line<'static>> = Vec::new();
    if let Some(error) = mentions.error() {
        lines.push(styled(format!("⚠ {}", clean_terminal(error)), color, false));
    } else if mentions.loading() {
        lines.push(styled(
            if zh { "搜索中…" } else { "Searching…" }.to_owned(),
            color,
            false,
        ));
    } else if mentions.items().is_empty() {
        lines.push(styled(
            if zh {
                "没有匹配的 workspace 路径"
            } else {
                "No matching workspace path"
            }
            .to_owned(),
            color,
            false,
        ));
    }
    let (window, selected) = mentions.window();
    for (offset, entry) in mentions.items()[window].iter().enumerate() {
        let marker = if offset == selected { "›" } else { " " };
        lines.push(styled(
            clean_terminal(&format!("{marker} {}", entry.path)),
            color,
            offset == selected,
        ));
    }
    if mentions.truncated() {
        lines.push(styled(
            if zh {
                "… 更多结果"
            } else {
                "… more results"
            }
            .to_owned(),
            color,
            false,
        ));
    }
    if lines.is_empty() {
        return;
    }
    let width = bounds.width.saturating_sub(4).clamp(12, MAX_WIDTH);
    let height = (lines.len() as u16 + 2).min(bounds.height).max(4);
    let popup = Rect::new(
        bounds.x + (bounds.width - width) / 2,
        bounds.bottom().saturating_sub(height),
        width,
        height,
    );
    let title = if zh {
        " 文件 · Tab 插入 "
    } else {
        " Files · Tab inserts "
    };
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Block::default().style(Style::default().bg(if color {
            Color::Rgb(22, 27, 34)
        } else {
            Color::Reset
        })),
        popup,
    );
    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(if color {
                    Color::Rgb(125, 211, 252)
                } else {
                    Color::Reset
                }))
                .title(clean_terminal(title)),
        ),
        popup,
    );
}

fn styled(text: String, color: bool, selected: bool) -> Line<'static> {
    let style = if !color {
        Style::default()
    } else if selected {
        Style::default()
            .fg(Color::Rgb(125, 211, 252))
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Rgb(229, 231, 235))
    };
    Line::from(vec![Span::styled(text, style)])
}
