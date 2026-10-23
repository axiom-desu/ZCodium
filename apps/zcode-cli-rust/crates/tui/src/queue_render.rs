//! composer 上方的队列条与队列编辑弹层渲染（只读投影，无业务写入）。
use crate::{
    presentation::{ACCENT, MUTED, TEXT},
    presentation_markdown::clean_terminal,
    projection::View,
    queue_state::{self, QueueEdit},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
};

/// 队列条：最多 `VISIBLE_ITEMS` 个排队项 + 剩余数量，paused/autoDrain 取 actor 真值。
///
/// 只读 `state.queue.items`；不插本地项、不因新 prompt 清空队列。
pub(crate) fn render_lines(view: &View, width: usize) -> Vec<String> {
    let items = queue_state::items(view);
    if items.is_empty() || width == 0 {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let header = if queue_state::auto_drain(view) {
        format!("{} {}", view.text("Queued", "排队中"), items.len())
    } else {
        format!(
            "{} {} · {}",
            view.text("Queue paused", "队列已暂停"),
            items.len(),
            view.text("/queue resume to continue", "使用 /queue resume 继续")
        )
    };
    lines.push(clip(&header, width));
    for item in items.iter().take(queue_state::VISIBLE_ITEMS) {
        let id = item["queueItemId"].as_str().unwrap_or("?");
        let kind = item["kind"].as_str().unwrap_or("sendText");
        let state = item["dispatch"]["state"].as_str().unwrap_or("queued");
        let text = item["text"]
            .as_str()
            .unwrap_or("")
            .replace(['\n', '\r'], " ");
        let marker = if state == "queued" { "" } else { "▶ " };
        lines.push(clip(&format!("  {marker}{id} · {kind} · {text}"), width));
    }
    if items.len() > queue_state::VISIBLE_ITEMS {
        lines.push(clip(
            &format!(
                "  +{} {}",
                items.len() - queue_state::VISIBLE_ITEMS,
                view.text("more", "更多")
            ),
            width,
        ));
    }
    lines
}

/// 队列编辑弹层跟随 `View.queue_edit`：文本、原项 id/kind 与只读附件数都来自本地草稿。
pub(crate) fn draw_edit(frame: &mut Frame<'_>, bounds: Rect, view: &View) {
    // 权限/问答优先：弹层自己也要暂停，不能依赖调用方已做门禁。
    if view.interaction().is_some() {
        return;
    }
    let Some(edit) = view.queue_edit.as_ref() else {
        return;
    };
    // 失效编辑不自动隐藏：保留同一 buffer 明确标注“不会提交”，用户 Esc 才取消，
    // 避免草稿像已被删除一样消失。它不是队列事实，只是本地编辑缓冲。
    let current = is_current(view, edit);
    if bounds.width < 12 || bounds.height < 5 {
        return;
    }
    let width = bounds.width.saturating_sub(8).clamp(10, 72);
    let inner_width = width.saturating_sub(2) as usize;
    let mut lines = vec![line(
        &format!("{} · {}", edit.queue_item_id, edit.kind),
        MUTED,
        inner_width,
    )];
    let text = edit.text();
    let mut body = text.lines().collect::<Vec<_>>();
    if body.is_empty() {
        body.push("");
    }
    for (index, value) in body.iter().enumerate() {
        let cursor = if index + 1 == body.len() { "▌" } else { "" };
        lines.push(line(
            &format!("{}{cursor}", if value.is_empty() { " " } else { value }),
            TEXT,
            inner_width,
        ));
    }
    if let Some(count) = edit
        .attachments
        .as_array()
        .filter(|items| !items.is_empty())
        .map(Vec::len)
    {
        lines.push(line(
            &if view.zh {
                format!("{count} 个附件保持原样")
            } else {
                format!("{count} attachment(s) kept as-is")
            },
            MUTED,
            inner_width,
        ));
    }
    if current {
        lines.push(line(
            view.text("Enter save · Esc cancel", "Enter 保存 · Esc 取消"),
            ACCENT,
            inner_width,
        ));
    } else {
        lines.push(line(
            view.text(
                "Esc cancel · closed session / old generation · not submitted",
                "Esc 取消 · 会话已关闭 / 旧世代 · 不会提交",
            ),
            ACCENT,
            inner_width,
        ));
    }
    let height = (lines.len() as u16 + 2).min(bounds.height).max(3);
    let popup = Rect::new(
        bounds.x + (bounds.width - width) / 2,
        bounds.y + (bounds.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Block::default().style(Style::default().bg(Color::Rgb(22, 27, 34))),
        popup,
    );
    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(clean_terminal(
            if current {
                view.text("Edit queued input", "编辑排队输入")
            } else {
                view.text(
                    "Stale queue edit (not submitted)",
                    "失效的排队编辑（不会提交）",
                )
            },
        ))),
        popup,
    );
}

/// 单行化 + 去 ANSI + 按终端显示宽度截断；宽度是硬边界，CJK/emoji 不被拆成半个字。
fn clip(value: &str, width: usize) -> String {
    let value = clean_terminal(value).replace(['\n', '\r', '\t'], " ");
    if width == 0 {
        return String::new();
    }
    if Line::raw(&value).width() <= width {
        return value;
    }
    let limit = width.saturating_sub(1);
    let mut out = String::new();
    let mut used = 0;
    for grapheme in Line::raw(&value).styled_graphemes(Style::default()) {
        let grapheme_width = Line::raw(grapheme.symbol).width();
        if used + grapheme_width > limit {
            break;
        }
        out.push_str(grapheme.symbol);
        used += grapheme_width;
    }
    out.push('…');
    out
}

fn line(value: &str, color: Color, width: usize) -> Line<'static> {
    Line::from(Span::styled(clip(value, width), Style::default().fg(color)))
}

/// 供集成层复用：编辑中的 `QueueEdit` 是否仍属于当前会话/世代。
pub(crate) fn is_current(view: &View, edit: &QueueEdit) -> bool {
    edit.session == view.session && edit.generation == view.generation
}
