//! `timelineMarker` 展示：只消费 core/domain 真实写入的 marker 字段。
//!
//! 支持的事实（取自已检出源码，不按字符串猜测统计）：
//! - `compact`：`origin`(manual/auto)、`status`(running/success/noop/failed/cancelled)、
//!   可选的 `tokensBefore` / `tokensAfter` / `summaryRef`，以及可选的错误/原因文本。
//! - `modelChange`：`from*`（首轮模型无来源时缺失）/`toProvider`/`toModel`/`toThought`。
//! - `checkpointRestored`：`checkpointId` 只表示文件检查点已恢复，不展示原始 id。
//! - `goalVerify`：`iteration`/`outcome`(running|pass|notSatisfied|failed)/`detail`。
//! - `forkNotice`：会话分叉事实，不展开父会话 id。
//!
//! 未知 marker 类型不输出任何一行，避免把内部 JSON 当成事实展示。
use ratatui::{
    style::{Color, Style},
    text::{Line, Span},
};
use serde_json::Value;

const ACCENT: Color = Color::Rgb(125, 211, 252);
const MUTED: Color = Color::Rgb(148, 163, 184);
const WARNING: Color = Color::Rgb(251, 191, 36);
const MAX_LABEL_CHARS: usize = 200;
const MAX_DETAIL_CHARS: usize = 64;

pub(super) fn marker_line(row: &Value, zh: bool) -> Option<Line<'static>> {
    let marker = &row["marker"];
    let kind = marker["type"].as_str()?;
    let (label, color) = match kind {
        "compact" => compact(marker, zh)?,
        "modelChange" => (model_change(marker, zh), MUTED),
        "checkpointRestored" => (
            text(zh, "Files restored from checkpoint", "已从检查点恢复文件").to_owned(),
            MUTED,
        ),
        "goalVerify" => goal_verify(marker, zh),
        "forkNotice" => (
            text(zh, "Session forked from parent", "会话已从父会话分叉").to_owned(),
            MUTED,
        ),
        _ => return None,
    };
    Some(Line::from(vec![
        Span::styled("── ", Style::default().fg(MUTED)),
        Span::styled(bounded(&label), Style::default().fg(color)),
        Span::styled(" ──", Style::default().fg(MUTED)),
    ]))
}

fn compact(marker: &Value, zh: bool) -> Option<(String, Color)> {
    let (status, color) = match marker["status"].as_str()? {
        "running" => (text(zh, "Compressing context", "正在压缩上下文"), ACCENT),
        "success" => (text(zh, "Context compressed", "上下文已压缩"), MUTED),
        "noop" => (
            text(
                zh,
                "Context is up to date; no compression needed",
                "上下文已是最新，无需压缩",
            ),
            MUTED,
        ),
        "failed" => (
            text(zh, "Context compression failed", "上下文压缩失败"),
            WARNING,
        ),
        "cancelled" => (
            text(zh, "Context compression interrupted", "上下文压缩已中断"),
            WARNING,
        ),
        // 未知状态不猜测成败，整行不展示。
        _ => return None,
    };
    let mut label = status.to_owned();
    match marker["origin"].as_str() {
        Some("manual") => label.push_str(text(zh, " (manual)", "（手动）")),
        Some("auto") => label.push_str(text(zh, " (auto)", "（自动）")),
        _ => {}
    }
    if let Some(tokens) = tokens(marker, zh) {
        label.push_str(" · ");
        label.push_str(&tokens);
    }
    // 只有真实存在的错误/原因字段才追加，缺失时保持状态文案。
    let detail = marker["error"]["message"]
        .as_str()
        .or(marker["error"].as_str())
        .or(marker["detail"].as_str())
        .or(marker["reason"].as_str());
    if let Some(detail) = detail.map(detail_field).filter(|d| !d.is_empty()) {
        label.push_str(" · ");
        label.push_str(&detail);
    }
    Some((label, color))
}

fn tokens(marker: &Value, zh: bool) -> Option<String> {
    let before = count(&marker["tokensBefore"]);
    let after = count(&marker["tokensAfter"]);
    match (before, after) {
        (Some(before), Some(after)) => {
            Some(format!("{} {before} → {after}", text(zh, "tokens", "令牌")))
        }
        (Some(before), None) => Some(format!("{} {before}", text(zh, "before", "压缩前"))),
        (None, Some(after)) => Some(format!("{} {after}", text(zh, "after", "压缩后"))),
        (None, None) => None,
    }
}

fn model_change(marker: &Value, zh: bool) -> String {
    let from = marker["fromModel"].as_str().map(bounded);
    let to = marker["toModel"].as_str().map(bounded);
    let provider = marker["toProvider"].as_str().map(bounded);
    let thought = marker["toThought"].as_str().map(bounded);
    let mut label = match (&from, &to) {
        (Some(from), Some(to)) => {
            format!("{} {from} → {to}", text(zh, "Model changed:", "模型切换："))
        }
        (None, Some(to)) => format!("{} {to}", text(zh, "Model:", "模型：")),
        _ => text(zh, "Model changed", "模型已切换").to_owned(),
    };
    if let Some(provider) = provider {
        label.push_str(&format!(" ({provider})"));
    }
    if let Some(thought) = thought {
        label.push_str(&format!(" · {} {thought}", text(zh, "thought", "思考")));
    }
    label
}

fn goal_verify(marker: &Value, zh: bool) -> (String, Color) {
    let (status, color) = match marker["outcome"].as_str() {
        Some("running") => (
            text(zh, "Goal verification running", "目标验证进行中"),
            ACCENT,
        ),
        Some("pass") => (text(zh, "Goal verification passed", "目标验证通过"), MUTED),
        Some("notSatisfied") => (
            text(zh, "Goal verification not satisfied", "目标验证未满足"),
            WARNING,
        ),
        Some("failed") => (
            text(zh, "Goal verification failed", "目标验证失败"),
            WARNING,
        ),
        _ => (text(zh, "Goal verification", "目标验证"), MUTED),
    };
    let mut label = status.to_owned();
    if let Some(iteration) = marker["iteration"].as_u64() {
        label.push_str(&format!(" #{iteration}"));
    }
    if let Some(detail) = marker["detail"].as_str().map(detail_field)
        && !detail.is_empty()
    {
        label.push_str(" · ");
        label.push_str(&detail);
    }
    (label, color)
}

fn count(value: &Value) -> Option<String> {
    let number = value
        .as_f64()
        .or_else(|| value.as_u64().map(|n| n as f64))?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    Some(compact_count(number))
}

fn compact_count(value: f64) -> String {
    if value < 1_000.0 {
        format!("{value:.0}")
    } else if value < 1_000_000.0 {
        decimal(value / 1_000.0, "K")
    } else {
        decimal(value / 1_000_000.0, "M")
    }
}

fn decimal(value: f64, suffix: &str) -> String {
    let text = format!("{value:.1}");
    let text = text.strip_suffix(".0").unwrap_or(&text);
    format!("{text}{suffix}")
}

fn detail_field(value: &str) -> String {
    let cleaned = super::presentation_markdown::clean_terminal(value)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_DETAIL_CHARS)
        .collect::<String>();
    cleaned.trim().to_owned()
}

fn bounded(value: &str) -> String {
    super::presentation_markdown::clean_terminal(value)
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_LABEL_CHARS)
        .collect()
}

fn text<'a>(zh: bool, en: &'a str, zh_text: &'a str) -> &'a str {
    if zh { zh_text } else { en }
}
