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
    pub fn cursor_line_col(&self) -> (usize, usize) {
        let before = &self.text[..self.cursor];
        (
            before.matches('\n').count(),
            ratatui::text::Line::raw(before.rsplit('\n').next().unwrap_or_default()).width(),
        )
    }
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
