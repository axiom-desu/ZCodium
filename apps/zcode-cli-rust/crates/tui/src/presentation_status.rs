//! Composer 底栏状态行：只从 `state.config` 派生 model / provider / thought。
//!
//! 与 TS `app-input-status.tsx` 的信息层次一致：model 是主信息，provider 弱化，
//! thought 用强调色；缺失字段显示 `—`。裁剪按终端显示宽度而不是字符数，控制字符
//! 与 ANSI/OSC 在进入 buffer 前清理，窄/极小终端只输出能放下的部分。
use super::presentation::{MUTED, TEXT};
use super::presentation_markdown::clean_terminal;
use crate::projection::View;
use ratatui::{
    style::{Color, Style},
    text::{Line, Span},
};

const SEPARATOR: &str = " | ";
const MODEL_PROVIDER_GAP: usize = 1;
const THOUGHT: Color = Color::Rgb(251, 191, 36);
const TRUNCATION: &str = "...";
const MAX_FIELD_CHARS: usize = 128;

pub(super) fn composer_status(view: &View, width: u16) -> Line<'static> {
    let (model, provider, thought) = parts(view);
    fitted(&model, &provider, &thought, width as usize)
}

/// `(model, provider, thought)`，每个都保证是可进 buffer 的单行文本。
pub(super) fn parts(view: &View) -> (String, String, String) {
    let config = &view.state["config"];
    (
        field(&config["model"]),
        field(&config["provider"]),
        field(&config["thought"]),
    )
}

fn field(value: &serde_json::Value) -> String {
    let Some(raw) = value.as_str() else {
        return "—".into();
    };
    // 先去掉 ANSI/OSC，再把剩余控制字符折叠为空格；否则换行会顶掉输入区。
    let cleaned = clean_terminal(raw)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_FIELD_CHARS)
        .collect::<String>();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "—".into()
    } else {
        trimmed.to_owned()
    }
}

fn fitted(model: &str, provider: &str, thought: &str, width: usize) -> Line<'static> {
    if width == 0 {
        return Line::default();
    }
    let model_width = cells(model);
    let provider_width = cells(provider);
    let thought_width = cells(thought);
    let separator_width = cells(SEPARATOR);
    let full = model_width + MODEL_PROVIDER_GAP + provider_width + separator_width + thought_width;
    if full <= width {
        return spans(model, provider, thought);
    }
    // 先给 thought 留位置，与 TS fitComposerStatusParts 的优先级一致。
    let budget = width.saturating_sub(separator_width + thought_width);
    if budget == 0 {
        return Line::from(Span::styled(
            truncate(thought, width),
            Style::default().fg(THOUGHT),
        ));
    }
    if budget <= MODEL_PROVIDER_GAP {
        return Line::from(Span::styled(
            truncate(model, budget),
            Style::default().fg(TEXT),
        ));
    }
    let provider_budget = provider_width.min((budget * 2 / 5).max(1));
    let model_budget = budget
        .saturating_sub(provider_budget + MODEL_PROVIDER_GAP)
        .max(1);
    let model = truncate(model, model_budget);
    let provider = truncate(provider, provider_budget);
    spans(&model, &provider, thought)
}

fn spans(model: &str, provider: &str, thought: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled(model.to_owned(), Style::default().fg(TEXT)),
        Span::styled(
            format!(" {provider}{SEPARATOR}"),
            Style::default().fg(MUTED),
        ),
        Span::styled(thought.to_owned(), Style::default().fg(THOUGHT)),
    ])
}

fn cells(text: &str) -> usize {
    Line::raw(text).width()
}

/// 按显示宽度裁剪，并在放得下时补 `...`；CJK/emoji 不会被拆成半个字。
fn truncate(value: &str, max: usize) -> String {
    if cells(value) <= max {
        return value.to_owned();
    }
    if max <= TRUNCATION.len() {
        return take_cells(value, max);
    }
    let limit = max - TRUNCATION.len();
    let mut out = String::new();
    let mut used = 0;
    for grapheme in Line::raw(value).styled_graphemes(Style::default()) {
        let width = Line::raw(grapheme.symbol).width();
        if used + width > limit {
            break;
        }
        out.push_str(grapheme.symbol);
        used += width;
    }
    out.push_str(TRUNCATION);
    out
}

fn take_cells(value: &str, max: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for grapheme in Line::raw(value).styled_graphemes(Style::default()) {
        let width = Line::raw(grapheme.symbol).width();
        if used + width > max {
            break;
        }
        out.push_str(grapheme.symbol);
        used += width;
    }
    out
}
