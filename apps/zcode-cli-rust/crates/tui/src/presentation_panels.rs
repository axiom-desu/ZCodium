use super::presentation::{ACCENT, MUTED, TEXT};
use super::presentation_markdown::clean_terminal;
use crate::projection::View;
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
};

const DANGER: Color = Color::Rgb(252, 165, 206);
const FILE_ROW_LIMIT: usize = 6;
const TODO_ROW_LIMIT: usize = 6;
const SUBAGENT_ROW_LIMIT: usize = 3;
const SCAN_ROW_LIMIT: usize = 400;

pub(super) fn draw_sidebar(frame: &mut Frame<'_>, area: Rect, view: &View) {
    frame.render_widget(
        Block::default().style(Style::default().bg(Color::Rgb(22, 27, 34))),
        area,
    );
    if area.width < 8 || area.height < 4 {
        return;
    }
    let inner = Rect::new(
        area.x + 1,
        area.y,
        area.width.saturating_sub(2),
        area.height,
    );
    let width = inner.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(header_line(width));
    lines.push(Line::raw(""));
    status_section(&mut lines, view, width);
    // 与 TS 侧栏一致：分区间留一个空行，避免所有标题挤成一片。
    lines.push(Line::raw(""));
    subagents_section(&mut lines, view, width);
    lines.push(Line::raw(""));
    modified_files_section(&mut lines, view, width);
    lines.push(Line::raw(""));
    todos_section(&mut lines, view, width);
    // 底部固定工作目录，和 TS 侧栏的 footer 一致；不足时不再补空行。
    let used = lines.len() as u16;
    let footer_y = area.y + area.height.saturating_sub(1);
    if inner.height > used {
        let footer = Rect::new(inner.x, footer_y, inner.width, 1);
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                truncate(&clean_terminal(&view.directory), width),
                Style::default().fg(MUTED),
            ))),
            footer,
        );
    }
    frame.render_widget(
        Paragraph::new(lines),
        Rect::new(
            inner.x,
            inner.y,
            inner.width,
            inner.height.saturating_sub(1),
        ),
    );
}

fn header_line(width: usize) -> Line<'static> {
    let version = format!(" {}", env!("CARGO_PKG_VERSION"));
    let name = "ZCodium";
    let version = truncate(&version, width.saturating_sub(name.chars().count()));
    Line::from(vec![
        Span::styled(
            name,
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::styled(version, Style::default().fg(MUTED)),
    ])
}

fn section_header(lines: &mut Vec<Line<'static>>, title: String, suffix: Option<String>) {
    let title = match suffix {
        Some(suffix) => format!("{title} ({suffix})"),
        None => title,
    };
    lines.push(Line::from(Span::styled(
        title,
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
    )));
}

fn status_section(lines: &mut Vec<Line<'static>>, view: &View, width: usize) {
    section_header(lines, view.text("Status", "状态").into(), None);
    let activity = if view.busy() {
        view.text("Running", "运行中")
    } else if !view.state["pendingInteractions"]
        .as_array()
        .is_none_or(|items| items.is_empty())
    {
        view.text("Awaiting your decision", "等待您的决定")
    } else if view.state["control"]["phase"] == "completedInterrupted" {
        view.text("Cancelled", "已取消")
    } else {
        view.text("Ready", "就绪")
    };
    lines.push(body_line(
        activity,
        if view.busy() { ACCENT } else { TEXT },
        width,
    ));
    let last = view.state["control"]["stopState"]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or("—");
    lines.push(body_line(
        &format!("{}  {last}", view.text("Last", "上次")),
        MUTED,
        width,
    ));
    if let Some(error) = view.state["control"]["lastError"]["message"]
        .as_str()
        .filter(|message| !message.is_empty())
    {
        lines.push(body_line(error, DANGER, width));
    }
}

fn subagents_section(lines: &mut Vec<Line<'static>>, view: &View, width: usize) {
    let running = view.state["subagents"]["running"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .collect::<Vec<_>>();
    section_header(
        lines,
        view.text("Subagents", "子代理").into(),
        Some(running.len().to_string()),
    );
    let ended = view.state["subagents"]["endedTotal"].as_u64().unwrap_or(0);
    if running.is_empty() && ended == 0 {
        lines.push(body_line(
            view.text("No subagents yet.", "暂无子代理。"),
            MUTED,
            width,
        ));
        return;
    }
    lines.push(body_line(
        &format!(
            "{} {} · {} {ended}",
            view.text("Running", "运行中"),
            running.len(),
            view.text("ended", "已完成")
        ),
        TEXT,
        width,
    ));
    for child in running.iter().take(SUBAGENT_ROW_LIMIT) {
        lines.push(body_line(child, MUTED, width));
    }
}

fn modified_files_section(lines: &mut Vec<Line<'static>>, view: &View, width: usize) {
    section_header(lines, view.text("Modified Files", "改动文件").into(), None);
    let files = modified_files(view);
    if files.is_empty() {
        lines.push(body_line(
            view.text("No file changes yet.", "暂无文件改动。"),
            MUTED,
            width,
        ));
        return;
    }
    for (path, additions, deletions) in files.into_iter().take(FILE_ROW_LIMIT) {
        lines.push(body_line(
            &format!("{}  +{additions} -{deletions}", compress_path(&path)),
            TEXT,
            width,
        ));
    }
}

/// 只聚合工具层已经给出的 file_diff 统计，不重新 diff 磁盘内容。
fn modified_files(view: &View) -> Vec<(String, u64, u64)> {
    let mut files: Vec<(String, u64, u64)> = Vec::new();
    for row in view.rows.iter().rev().take(SCAN_ROW_LIMIT) {
        let display = &row["output"]["display"];
        if display["kind"] != "file_diff" {
            continue;
        }
        let Some(path) = display["filePath"].as_str().filter(|path| !path.is_empty()) else {
            continue;
        };
        let additions = display["additions"].as_u64().unwrap_or(0);
        let deletions = display["deletions"].as_u64().unwrap_or(0);
        match files.iter_mut().find(|(known, _, _)| known == path) {
            Some((_, known_additions, known_deletions)) => {
                *known_additions += additions;
                *known_deletions += deletions;
            }
            None => files.push((path.to_owned(), additions, deletions)),
        }
    }
    files
}

fn todos_section(lines: &mut Vec<Line<'static>>, view: &View, width: usize) {
    section_header(lines, view.text("Todos", "待办").into(), None);
    let items = view.state["plan"]["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if items.is_empty() {
        lines.push(body_line(
            view.text("No todos yet.", "暂无待办。"),
            MUTED,
            width,
        ));
        return;
    }
    let completed = items
        .iter()
        .filter(|item| item["status"] == "completed")
        .count();
    lines.push(body_line(
        &format!(
            "{} {completed}/{}",
            view.text("Progress", "进度"),
            items.len()
        ),
        TEXT,
        width,
    ));
    for item in items.iter().take(TODO_ROW_LIMIT) {
        let (marker, color) = match item["status"].as_str() {
            Some("completed") => ("✔", Color::Rgb(134, 239, 172)),
            Some("inProgress") => ("▶", ACCENT),
            _ => ("○", MUTED),
        };
        let content = item["content"].as_str().unwrap_or("");
        lines.push(body_line(&format!("{marker} {content}"), color, width));
    }
    if items.len() > TODO_ROW_LIMIT {
        lines.push(body_line(
            &format!("+{}", items.len() - TODO_ROW_LIMIT),
            MUTED,
            width,
        ));
    }
}

fn body_line(value: &str, color: Color, width: usize) -> Line<'static> {
    Line::from(Span::styled(
        truncate(&clean_terminal(value), width),
        Style::default().fg(color),
    ))
}

fn truncate(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.to_owned();
    }
    let mut out = value
        .chars()
        .take(width.saturating_sub(1))
        .collect::<String>();
    out.push('…');
    out
}

/// 侧栏宽度固定，长路径从左侧压缩成 `…/parent/name`，保留文件自身可读性。
fn compress_path(path: &str) -> String {
    let parts = path.rsplit('/').take(2).collect::<Vec<_>>();
    match parts.as_slice() {
        [name, parent] => format!("…/{parent}/{name}"),
        [name] => (*name).to_owned(),
        _ => path.to_owned(),
    }
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
