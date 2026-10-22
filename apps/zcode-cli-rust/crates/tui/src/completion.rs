//! Slash 命令补全的纯前端状态。
//!
//! 候选只来自 [`crate::commands`]，这里不持有会话事实，也不提交任何命令：
//! Tab/Enter 只是把 canonical `/name` 写回编辑器，分流仍由原 transport 入口负责。
use crate::{
    commands::{self, Command},
    presentation_markdown::clean_terminal,
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
};

/// 建议面板一次可见的最大行数（spec：候选最多 8 可见）。
pub(crate) const MAX_VISIBLE: usize = 8;
/// 候选本身也有界，避免异常目录把每次编辑键变成无界分配。
const MAX_CANDIDATES: usize = 32;
const MAX_WIDTH: u16 = 72;

#[derive(Default)]
pub(crate) struct Completion {
    /// 上一次收敛时的草稿；Esc 的隐藏只对这份草稿生效。
    draft: String,
    enabled: bool,
    dismissed: bool,
    candidates: Vec<&'static Command>,
    selected: usize,
}

/// `/` 后有空白或没有前导斜杠时不是补全输入。
fn needle(draft: &str) -> Option<String> {
    let rest = draft.strip_prefix('/')?;
    if draft.chars().any(char::is_whitespace) {
        return None;
    }
    Some(rest.to_ascii_lowercase())
}

/// 精确匹配 > 前缀 > 子串；canonical 名称优先于别名。
fn rank(haystack: &str, needle: &str) -> Option<u8> {
    if haystack == needle {
        Some(0)
    } else if haystack.starts_with(needle) {
        Some(1)
    } else if haystack.contains(needle) {
        Some(2)
    } else {
        None
    }
}

fn score(command: &Command, needle: &str) -> Option<u8> {
    let mut best = rank(&command.name.to_ascii_lowercase(), needle).map(|rank| rank * 2);
    for alias in command.aliases {
        if let Some(rank) = rank(&alias.to_ascii_lowercase(), needle) {
            let score = rank * 2 + 1;
            best = Some(best.map_or(score, |current| current.min(score)));
        }
    }
    best
}

fn matches(draft: &str) -> Vec<&'static Command> {
    let Some(needle) = needle(draft) else {
        return Vec::new();
    };
    let mut scored = commands::all()
        .iter()
        .filter_map(|command| score(command, &needle).map(|score| (score, command)))
        .collect::<Vec<_>>();
    // 只按匹配分数稳定排序，同分保持 commands 目录顺序：
    // 目录顺序就是产品默认项，额外按字母排序会把 `/` 的默认候选从 help 改成 compact。
    scored.sort_by_key(|(score, _)| *score);
    scored
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|(_, command)| command)
        .collect()
}

impl Completion {
    /// 每次真实键/paste 或快照变化后收敛；同一草稿保留选中下标。
    pub(crate) fn reconcile(&mut self, draft: &str, enabled: bool) {
        let draft_changed = self.draft != draft;
        if draft_changed {
            self.draft.clear();
            self.draft.push_str(draft);
            self.dismissed = false;
            self.selected = 0;
        }
        // 草稿和启用状态都没变时保留选中的候选，只做下标收敛；
        // 这样高频快照不会每次编辑都重建候选表。
        if draft_changed || self.enabled != enabled {
            self.candidates = if enabled && !self.dismissed {
                matches(draft)
            } else {
                Vec::new()
            };
        }
        self.enabled = enabled;
        self.selected = self.selected.min(self.candidates.len().saturating_sub(1));
    }

    pub(crate) fn candidates(&self) -> Vec<&'static Command> {
        self.candidates.clone()
    }

    pub(crate) fn selected(&self) -> usize {
        self.selected
    }

    /// 候选面板是否正在显示；隐藏后不会消费上下键。
    pub(crate) fn visible(&self) -> bool {
        !self.candidates.is_empty() && !self.dismissed
    }

    pub(crate) fn move_by(&mut self, delta: isize) {
        if self.candidates.is_empty() {
            return;
        }
        self.selected =
            (self.selected as isize + delta).rem_euclid(self.candidates.len() as isize) as usize;
    }

    /// Esc 只隐藏“当前草稿”的补全，草稿一旦变化就恢复。
    pub(crate) fn dismiss(&mut self) {
        self.dismissed = true;
        self.candidates.clear();
        self.selected = 0;
    }

    /// 返回写回编辑器的 canonical `/name`；从不直接提交。
    ///
    /// 只要候选列表里选中的是可见项，Tab/Enter 就写回它的 canonical 名称：
    /// 补全按子串匹配展示，若再用“前缀”二次过滤，`/`、`/odel` 这类可见候选
    /// 点了没反应，违背 TS 行为与 spec（选中候选即可确认）。
    /// 未知命令（如 `/compactfoo`）没有候选，因此不会被补全成任何控制命令。
    pub(crate) fn replacement(&self) -> Option<String> {
        needle(&self.draft)?;
        self.candidates
            .get(self.selected)
            .map(|command| format!("/{}", command.name))
    }
}

/// 有界建议面板；presentation 只调用这一个入口。
pub(crate) fn draw(frame: &mut Frame<'_>, bounds: Rect, completion: &Completion, zh: bool) {
    if !completion.visible() || bounds.width < 12 || bounds.height < 4 {
        return;
    }
    // 只借用一次候选快照，后续边界计算都基于同一份数据。
    let candidates = completion.candidates();
    let width = bounds.width.saturating_sub(4).clamp(1, MAX_WIDTH);
    let height = (candidates.len().min(MAX_VISIBLE) as u16 + 2).min(bounds.height);
    let rows = height.saturating_sub(2) as usize;
    if rows == 0 {
        return;
    }
    let visible = candidates.len().min(MAX_VISIBLE).min(rows);
    let popup = Rect::new(
        bounds.x + (bounds.width - width) / 2,
        bounds.bottom().saturating_sub(height),
        width,
        height,
    );
    // 选中项始终留在窗口内，窗口本身不越过候选边界。
    let start = completion
        .selected()
        .saturating_sub(visible.saturating_sub(1))
        .min(candidates.len() - visible);
    let lines = candidates
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
        .map(|(index, command)| {
            let selected = index == completion.selected();
            let summary = if zh {
                command.summary_zh
            } else {
                command.summary_en
            };
            // 命令目录是静态表，但仍按不可信文本清理 ANSI/OSC。
            let text = clean_terminal(&format!(
                "{} /{}  {}",
                if selected { "›" } else { " " },
                command.name,
                summary
            ));
            Line::from(Span::styled(
                text,
                if selected {
                    Style::default()
                        .fg(Color::Rgb(125, 211, 252))
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Rgb(229, 231, 235))
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
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Rgb(125, 211, 252)))
                .title(clean_terminal(if zh {
                    " 命令 · Tab 补全 "
                } else {
                    " Commands · Tab completes "
                })),
        ),
        popup,
    );
}

#[cfg(test)]
#[path = "completion_tests.rs"]
mod completion_tests;
