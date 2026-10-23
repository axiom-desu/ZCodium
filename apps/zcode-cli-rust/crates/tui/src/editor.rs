#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct Editor {
    text: String,
    cursor: usize,
}
impl Editor {
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn insert(&mut self, text: &str) {
        self.text.insert_str(self.cursor, text);
        self.cursor += text.len();
    }
    pub fn left(&mut self) {
        self.cursor = self.text[..self.cursor]
            .char_indices()
            .next_back()
            .map_or(0, |(i, _)| i);
    }
    pub fn right(&mut self) {
        self.cursor = self.text[self.cursor..]
            .char_indices()
            .nth(1)
            .map_or(self.text.len(), |(i, _)| self.cursor + i);
    }
    pub fn home(&mut self) {
        self.cursor = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
    }
    pub fn end(&mut self) {
        self.cursor = self.text[self.cursor..]
            .find('\n')
            .map_or(self.text.len(), |i| self.cursor + i);
    }
    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let start = self.text[..self.cursor]
                .char_indices()
                .next_back()
                .map_or(0, |(i, _)| i);
            self.text.replace_range(start..self.cursor, "");
            self.cursor = start;
        }
    }
    pub fn delete(&mut self) {
        if let Some(ch) = self.text[self.cursor..].chars().next() {
            self.text
                .replace_range(self.cursor..self.cursor + ch.len_utf8(), "");
        }
    }
    pub fn clear(&mut self) -> String {
        self.cursor = 0;
        std::mem::take(&mut self.text)
    }
    /// 整段替换（补全写回/恢复草稿）；游标落在末尾，避免在旧偏移上继续编辑。
    pub fn replace_all(&mut self, text: &str) {
        self.text.clear();
        self.text.push_str(text);
        self.cursor = self.text.len();
    }
    /// UTF-8 字节游标偏移；`@file` token 解析需要与编辑器同一份偏移量。
    pub fn cursor_offset(&self) -> usize {
        self.cursor
    }
    /// 光标的垂直列（按字符数），跨行移动时尽量保持列。
    fn cursor_column(&self) -> usize {
        let start = self.text[..self.cursor]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        self.text[start..self.cursor].chars().count()
    }
    /// 上一行同列；已在首行返回 false，交给历史召回。
    pub fn up(&mut self) -> bool {
        let start = self.text[..self.cursor]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        if start == 0 {
            return false;
        }
        let previous = self.text[..start - 1]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        let column = self.cursor_column();
        self.cursor = line_offset(&self.text, previous, start - 1, column);
        true
    }
    /// 下一行同列；已在末行返回 false，交给历史翻页。
    pub fn down(&mut self) -> bool {
        let Some(newline) = self.text[self.cursor..].find('\n') else {
            return false;
        };
        let column = self.cursor_column();
        let next = self.cursor + newline + 1;
        let end = self.text[next..]
            .find('\n')
            .map_or(self.text.len(), |index| next + index);
        self.cursor = line_offset(&self.text, next, end, column);
        true
    }
    /// 覆盖 `[start,end)` 字节范围（必须都在字符边界内）；游标落到替换文本末尾。
    /// 非法范围返回 false 且不改编辑器，避免把半字节写进草稿。
    pub fn replace_range(&mut self, start: usize, end: usize, text: &str) -> bool {
        if start > end
            || end > self.text.len()
            || !self.text.is_char_boundary(start)
            || !self.text.is_char_boundary(end)
        {
            return false;
        }
        self.text.replace_range(start..end, text);
        self.cursor = start + text.len();
        true
    }
    pub fn cursor_line_col(&self) -> (usize, usize) {
        let before = &self.text[..self.cursor];
        (
            before.matches('\n').count(),
            ratatui::text::Line::raw(
                before
                    .rsplit('\n')
                    .next()
                    .unwrap_or_default()
                    .replace('\t', "    "),
            )
            .width(),
        )
    }
}

/// 在 `[start,end)` 内找到第 `column` 个字符的字节位置；列超出时停在行尾。
fn line_offset(text: &str, start: usize, end: usize, column: usize) -> usize {
    text[start..end]
        .char_indices()
        .nth(column)
        .map_or(end, |(index, _)| start + index)
}

pub fn sanitize(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            '\n' | '\t' => c,
            c if c.is_control() => '�',
            c => c,
        })
        .collect()
}

#[cfg(test)]
pub fn clamp_scroll(offset: usize, content: usize, visible: usize) -> usize {
    offset.min(content.saturating_sub(visible))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_edit_and_multiline_paste() {
        let mut e = Editor::default();
        e.insert("你🙂\n世界");
        e.left();
        e.backspace();
        assert_eq!(e.text(), "你🙂\n界");
        e.home();
        e.insert("x");
        assert_eq!(e.text(), "你🙂\nx界");
        assert_eq!(e.cursor_line_col(), (1, 1));
    }
    #[test]
    fn sanitize_controls_and_scroll_bounds() {
        assert_eq!(sanitize("ok\x1b[31m\x07\n"), "ok�[31m�\n");
        assert_eq!(clamp_scroll(10, 8, 3), 5);
    }
}
