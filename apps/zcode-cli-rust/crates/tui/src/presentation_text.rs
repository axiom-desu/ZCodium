use ratatui::{
    style::Style,
    text::{Line, Span},
};
use std::collections::VecDeque;

fn push(lines: &mut VecDeque<Line<'static>>, line: Line<'static>, used: &mut usize) {
    *used += bytes(std::slice::from_ref(&line));
    lines.push_back(line);
    while lines.len() > 32768 || *used > crate::projection::MAX_RENDER_BYTES {
        if let Some(old) = lines.pop_front() {
            *used = used.saturating_sub(bytes(&[old]));
        } else {
            break;
        }
    }
}
// 只缓存显示行；按 grapheme/cell 包裹，不能拆开 CJK、组合字符或 emoji。
pub(super) fn wrap(lines: Vec<Line<'static>>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut output = VecDeque::new();
    let mut bytes_used = 0;
    for line in lines {
        let mut spans = Vec::new();
        let mut used = 0;
        for span in line.spans {
            let mut chunk = String::new();
            for g in span.styled_graphemes(Style::default()) {
                let cells = Line::raw(g.symbol).width();
                if used + cells > width && used > 0 {
                    if !chunk.is_empty() {
                        spans.push(Span::styled(std::mem::take(&mut chunk), span.style));
                    }
                    push(
                        &mut output,
                        Line::from(std::mem::take(&mut spans)),
                        &mut bytes_used,
                    );
                    used = 0;
                }
                if cells > width {
                    chunk.push('�');
                    used += 1;
                } else {
                    chunk.push_str(g.symbol);
                    used += cells;
                }
            }
            if !chunk.is_empty() {
                spans.push(Span::styled(chunk, span.style));
            }
        }
        push(&mut output, Line::from(spans), &mut bytes_used);
    }
    output.into_iter().collect()
}
pub(super) fn bytes(lines: &[Line<'_>]) -> usize {
    lines
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.len()).sum::<usize>() + 1)
        .sum()
}
pub(super) fn input_window(
    text: &str,
    row: usize,
    height: usize,
    col: usize,
    width: usize,
) -> String {
    let start = row.saturating_sub(height.saturating_sub(1));
    let left = col.saturating_sub(width.saturating_sub(1));
    text.lines()
        .skip(start)
        .take(height)
        .map(|line| {
            let mut used = 0;
            let mut out = String::new();
            let line = Line::raw(line);
            for span in &line.spans {
                for g in span.styled_graphemes(Style::default()) {
                    let cells = Line::raw(g.symbol).width();
                    if used >= left && used + cells <= left + width {
                        out.push_str(g.symbol);
                    } else if used < left && used + cells > left {
                        out.push(' ');
                    }
                    used += cells;
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("\n")
}
