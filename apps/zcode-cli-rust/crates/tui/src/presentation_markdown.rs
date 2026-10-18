use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use serde_json::Value;
const ACCENT: Color = Color::Rgb(125, 211, 252);
const MUTED: Color = Color::Rgb(148, 163, 184);
const PANEL: Color = Color::Rgb(22, 27, 34);
const GREEN: Color = Color::Rgb(134, 239, 172);
const RED: Color = Color::Rgb(252, 165, 165);
const GOLD: Color = Color::Rgb(251, 191, 36);

pub(super) fn tool_card(lines: &mut Vec<Line<'static>>, row: &Value) {
    let status = row["status"].as_str().unwrap_or("unknown");
    let failed = status.contains("fail") || !row["error"]["message"].is_null();
    let color = if failed {
        RED
    } else if status.contains("run") || status == "pending" {
        GOLD
    } else if matches!(status, "completed" | "succeeded" | "done") {
        GREEN
    } else {
        MUTED
    };
    let name = clean_terminal(
        &row["toolName"]
            .as_str()
            .unwrap_or("Tool")
            .chars()
            .take(512)
            .collect::<String>(),
    );
    lines.push(Line::from(vec![
        Span::styled(
            format!("╭ {name}  "),
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            clean_terminal(&status.chars().take(128).collect::<String>()),
            Style::default().fg(color),
        ),
    ]));
    if let Some(input) = row["inputText"].as_str().filter(|s| !s.is_empty()) {
        lines.push(Line::from(Span::styled(
            "│ Input",
            Style::default().fg(MUTED),
        )));
        markdown_into(lines, input, true);
    }
    let output = row["output"]["text"]
        .as_str()
        .or(row["error"]["message"].as_str())
        .unwrap_or("");
    if !output.is_empty() {
        lines.push(Line::from(Span::styled(
            if failed { "│ Error" } else { "│ Output" },
            Style::default().fg(if failed { RED } else { MUTED }),
        )));
        markdown_into(lines, output, true);
    }
    let display = &row["output"]["display"];
    if display["kind"] == "file_diff" {
        let mut count = 0;
        for hunk in display["structuredPatch"]
            .as_array()
            .into_iter()
            .flatten()
            .take(12)
        {
            for raw in hunk["lines"].as_array().into_iter().flatten() {
                if count >= 12 {
                    break;
                }
                if let Some(raw) = raw.as_str() {
                    let text = clean_terminal(&raw.chars().take(256).collect::<String>());
                    let color = if raw.starts_with('+') {
                        GREEN
                    } else if raw.starts_with('-') {
                        RED
                    } else {
                        MUTED
                    };
                    lines.push(Line::from(Span::styled(text, Style::default().fg(color))));
                    count += 1;
                }
            }
            if count >= 12 {
                break;
            }
        }
    }
    lines.push(Line::from(Span::styled("╰─", Style::default().fg(MUTED))));
}
pub(super) fn markdown_into(out: &mut Vec<Line<'static>>, source: &str, preserve: bool) {
    let clean = clean_terminal(source);
    if preserve {
        // 工具参数/输出不是 Markdown；不能吞掉 JSON、Shell 的星号、代码围栏或缩进。
        let diff = clean
            .lines()
            .any(|l| l.starts_with("@@ ") || l.starts_with("diff --git "));
        for raw in clean.split('\n') {
            let color = if diff && raw.starts_with('+') {
                GREEN
            } else if diff && raw.starts_with('-') {
                RED
            } else {
                Color::Rgb(190, 198, 208)
            };
            out.push(Line::from(Span::styled(
                raw.to_owned(),
                Style::default().fg(color),
            )));
        }
        return;
    }
    let mut fenced = false;
    let mut diff = false;
    for raw in clean.split('\n') {
        if let Some(language) = raw.strip_prefix("```") {
            fenced = !fenced;
            diff = fenced && language.trim() == "diff";
            out.push(Line::from(Span::styled(
                if fenced {
                    format!("┌ code · {}", language.trim())
                } else {
                    "└ code".into()
                },
                Style::default().fg(MUTED),
            )));
            continue;
        }
        if fenced {
            let color = if diff && raw.starts_with('+') {
                GREEN
            } else if diff && raw.starts_with('-') {
                RED
            } else {
                Color::Rgb(190, 198, 208)
            };
            out.push(Line::from(Span::styled(
                raw.to_owned(),
                Style::default().fg(color).bg(PANEL),
            )));
            continue;
        }
        let trim = raw.trim_start();
        let heading = trim.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&heading) && trim.as_bytes().get(heading) == Some(&b' ') {
            out.push(Line::from(Span::styled(
                trim[heading + 1..].to_owned(),
                Style::default().fg(GOLD).add_modifier(Modifier::BOLD),
            )));
            continue;
        }
        if let Some(item) = trim.strip_prefix("- ").or_else(|| trim.strip_prefix("* ")) {
            let mut spans = vec![Span::styled("• ", Style::default().fg(ACCENT))];
            spans.extend(parse_inline(item));
            out.push(Line::from(spans));
            continue;
        }
        out.push(Line::from(parse_inline(raw)));
    }
}
fn parse_inline(text: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let token = ["**", "__", "`", "*", "["]
            .into_iter()
            .filter_map(|t| rest.find(t).map(|i| (i, t)))
            .min_by_key(|(i, _)| *i);
        let Some((start, marker)) = token else {
            spans.push(Span::raw(rest.to_owned()));
            break;
        };
        if start > 0 {
            spans.push(Span::raw(rest[..start].to_owned()));
        }
        let tail = &rest[start + marker.len()..];
        if marker == "[" {
            if let Some((label, end)) = tail.split_once("](")
                && let Some((url, remaining)) = end.split_once(')')
            {
                spans.push(Span::styled(
                    format!("{label} ({url})"),
                    Style::default()
                        .fg(ACCENT)
                        .add_modifier(Modifier::UNDERLINED),
                ));
                rest = remaining;
                continue;
            }
        } else if let Some(end) = tail.find(marker) {
            let style = if marker == "`" {
                Style::default().fg(GOLD).bg(PANEL)
            } else if marker.len() == 2 {
                Style::default().add_modifier(Modifier::BOLD)
            } else {
                Style::default().add_modifier(Modifier::ITALIC)
            };
            spans.push(Span::styled(tail[..end].to_owned(), style));
            rest = &tail[end + marker.len()..];
            continue;
        }
        spans.push(Span::raw(marker.to_owned()));
        rest = tail;
    }
    spans
}
pub(super) fn clean_terminal(input: &str) -> String {
    let mut out = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('^') | Some('_') => {
                    let mut prev = '\0';
                    for c in chars.by_ref() {
                        if c == '\x07' || (prev == '\x1b' && c == '\\') {
                            break;
                        }
                        prev = c;
                    }
                }
                _ => {}
            }
        } else if ch == '\u{9b}' {
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        } else if ch == '\t' {
            out.push_str("    ");
        } else if ch == '\n' || !ch.is_control() {
            out.push(ch);
        } else {
            out.push('�');
        }
    }
    out
}
