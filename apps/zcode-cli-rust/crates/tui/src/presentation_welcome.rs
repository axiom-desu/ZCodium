use super::presentation::{ACCENT, MUTED, TEXT, transcript_block};
use crate::projection::View;
use ratatui::{
    Frame,
    style::{Color, Style},
    text::{Line, Span},
    widgets::Paragraph,
};

/// 与 TS 欢迎标识一致的扫光节奏：1800ms 一轮、光带半宽 5 列、峰值混合 0.9。
/// 帧间隔（80ms）由 transport 的重绘节拍决定。
const SHIMMER_SWEEP_PERIOD_MS: u64 = 1_800;
const SHIMMER_PADDING_COLUMNS: usize = 10;
const SHIMMER_BAND_HALF_WIDTH: f64 = 5.0;
const SHIMMER_HIGHLIGHT_STRENGTH: f64 = 0.9;

/// 欢迎页只在没有任何正文与告警时出现；对话框与错误仍走正常正文路径。
pub(crate) fn is_welcome(view: &View) -> bool {
    let error = view.state["control"]["lastError"]["message"]
        .as_str()
        .is_some_and(|message| !message.is_empty());
    view.rows.is_empty()
        && view.notices.is_empty()
        && !error
        && view.state["control"]["phase"] != "completedInterrupted"
}

pub(crate) fn draw_welcome(
    frame: &mut Frame<'_>,
    area: ratatui::layout::Rect,
    view: &View,
    frame_ms: u64,
    bh: usize,
) {
    let mut lines: Vec<Line<'static>> = Vec::new();
    if area.width >= 54 {
        for line in crate::presentation_panels::LOGO {
            lines.push(Line::from(shimmer_spans(line, frame_ms)));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "ZCODIUM · Rust",
            Style::default().fg(ACCENT),
        )));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        view.text(
            "Rust-native assistant · /model · /mode · /sessions",
            "Rust 原生助手 · /model 模型 · /mode 模式 · /sessions 会话",
        ),
        Style::default().fg(MUTED),
    )));
    let pad = bh.saturating_sub(lines.len()) / 2;
    let mut centered = vec![Line::raw(""); pad];
    centered.extend(lines);
    frame.render_widget(
        Paragraph::new(centered)
            .style(Style::default().fg(TEXT))
            .alignment(ratatui::layout::Alignment::Center)
            .block(transcript_block()),
        area,
    );
}

/// 逐字符混合出扫光颜色；与 TS 的 ShimmerText 使用同一组节奏与强度常量。
fn shimmer_spans(text: &str, frame_ms: u64) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    let period = chars.len() + SHIMMER_PADDING_COLUMNS * 2;
    let sweep = ((frame_ms % SHIMMER_SWEEP_PERIOD_MS) as f64 / SHIMMER_SWEEP_PERIOD_MS as f64
        * period as f64)
        .floor() as usize;
    chars
        .into_iter()
        .enumerate()
        .map(|(index, symbol)| {
            let position = index + SHIMMER_PADDING_COLUMNS;
            let distance = position.abs_diff(sweep) as f64;
            let intensity = if distance > SHIMMER_BAND_HALF_WIDTH {
                0.0
            } else {
                0.5 * (1.0 + (std::f64::consts::PI * distance / SHIMMER_BAND_HALF_WIDTH).cos())
            };
            Span::styled(
                symbol.to_string(),
                Style::default().fg(blend(ACCENT, TEXT, intensity * SHIMMER_HIGHLIGHT_STRENGTH)),
            )
        })
        .collect()
}

fn blend(base: Color, highlight: Color, amount: f64) -> Color {
    let (Color::Rgb(br, bg, bb), Color::Rgb(hr, hg, hb)) = (base, highlight) else {
        return base;
    };
    let mix = |from: u8, to: u8| {
        (from as f64 + (to as f64 - from as f64) * amount.clamp(0.0, 1.0)).round() as u8
    };
    Color::Rgb(mix(br, hr), mix(bg, hg), mix(bb, hb))
}
