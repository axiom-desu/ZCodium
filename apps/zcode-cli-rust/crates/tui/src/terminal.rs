use crate::{editor::sanitize, interactions, projection::View};
use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout},
    widgets::{Block, Borders, Paragraph},
};

fn wrap(lines: Vec<String>, width: usize) -> Vec<String> {
    let mut result = Vec::new();
    for source in lines {
        let mut line = String::new();
        let mut columns = 0;
        for ch in source.chars() {
            let size = ratatui::text::Line::raw(ch.to_string()).width();
            if columns + size > width && !line.is_empty() {
                result.push(std::mem::take(&mut line));
                columns = 0;
            }
            line.push(ch);
            columns += size;
        }
        result.push(line);
    }
    result
}
pub(crate) fn draw(frame: &mut Frame<'_>, view: &View) {
    let height = (view.editor.text().lines().count().max(1) + 2).min(7) as u16;
    let areas = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(2),
            Constraint::Length(height),
            Constraint::Length(1),
        ])
        .split(frame.area());
    let body = wrap(
        view.lines(),
        usize::from(areas[0].width.saturating_sub(2)).max(1),
    );
    let visible = usize::from(areas[0].height.saturating_sub(2));
    let start = if view.follow {
        body.len().saturating_sub(visible)
    } else {
        crate::editor::clamp_scroll(view.scroll, body.len(), visible)
    };
    frame.render_widget(
        Paragraph::new(body.into_iter().skip(start).collect::<Vec<_>>().join("\n")).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" ZCodium Rust "),
        ),
        areas[0],
    );
    let prompt = view
        .interaction()
        .map(interactions::prompt)
        .unwrap_or_else(|| {
            view.text(
                "Enter send · Alt/Shift+Enter newline · Ctrl+C stop/quit · /help",
                "Enter 发送 · Alt/Shift+Enter 换行 · Ctrl+C 取消/退出 · /help",
            )
            .into()
        });
    frame.render_widget(Paragraph::new(sanitize(&prompt)), areas[1]);
    let (line, col) = view.editor.cursor_line_col();
    let input_scroll = line.saturating_sub(usize::from(areas[2].height.saturating_sub(3)));
    frame.render_widget(
        Paragraph::new(view.editor.text().to_owned())
            .scroll((input_scroll as u16, 0))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(view.text(" Message ", " 输入 ")),
            ),
        areas[2],
    );
    let state = if view.busy() {
        view.text("running", "运行中")
    } else {
        view.text("ready", "就绪")
    };
    let footer = format!(
        "{} · {} · {} · {state}",
        view.session,
        view.state["config"]["mode"].as_str().unwrap_or(""),
        view.state["config"]["model"].as_str().unwrap_or("")
    );
    frame.render_widget(Paragraph::new(sanitize(&footer)), areas[3]);
    frame.set_cursor_position((
        areas[2]
            .x
            .saturating_add(1 + col as u16)
            .min(areas[2].right().saturating_sub(2)),
        areas[2]
            .y
            .saturating_add(1 + (line - input_scroll) as u16)
            .min(areas[2].bottom().saturating_sub(2)),
    ));
}
