use crate::presentation_markdown::clean_terminal;
use serde_json::Value;

/// filter 只影响本地展示，上限与选项/标签上限一样是硬边界，避免粘贴撑大 TUI 状态。
pub(crate) const MAX_FILTER_CHARS: usize = 256;
const MAX_OPTIONS: usize = 200;
const MAX_LABEL_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Choice {
    Model(Value),
    Mode(String),
    Session(String),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Selector {
    pub title: String,
    /// typed choices 的唯一来源；filter 只借用这里，不复制第二份选择列表。
    pub options: Vec<(Choice, String)>,
    /// 过滤后列表中的序号，不是原始 `options` 的下标。
    pub selected: usize,
    pub owner: String,
    pub draft: String,
    pub filter: String,
}
impl Selector {
    pub fn new(
        title: String,
        options: Vec<(Choice, String)>,
        owner: String,
        draft: String,
    ) -> Option<Self> {
        let options = options
            .into_iter()
            .take(MAX_OPTIONS)
            .map(|(action, label)| {
                let label = crate::editor::sanitize(&label).replace(['\n', '\t'], " ");
                (action, label.chars().take(MAX_LABEL_CHARS).collect())
            })
            .collect::<Vec<_>>();
        (!options.is_empty()).then_some(Self {
            title,
            options,
            selected: 0,
            owner,
            draft,
            filter: String::new(),
        })
    }
    /// 大小写不敏感子串匹配 label，并额外匹配 typed 标识（`provider:model`、会话 id）。
    pub fn filtered_options(&self) -> Vec<&(Choice, String)> {
        if self.filter.is_empty() {
            return self.options.iter().collect();
        }
        let needle = self.filter.to_lowercase();
        self.options
            .iter()
            .filter(|(choice, label)| searchable(choice, label).contains(&needle))
            .collect()
    }
    pub fn choice(&self) -> Option<&(Choice, String)> {
        let filtered = self.filtered_options();
        filtered.get(self.index(filtered.len())).copied()
    }
    pub fn move_by(&mut self, delta: isize) {
        let len = self.filtered_options().len();
        if len == 0 {
            self.selected = 0;
            return;
        }
        let current = self.selected.min(len - 1) as isize;
        self.selected = (current + delta).rem_euclid(len as isize) as usize;
    }
    /// 打印字符/Paste 只进入 filter；控制序列先清理，再按 Unicode 字符数截断。
    pub fn push_filter(&mut self, text: &str) {
        let room = MAX_FILTER_CHARS.saturating_sub(self.filter.chars().count());
        if room == 0 {
            return;
        }
        let addition = filter_input(text).chars().take(room).collect::<String>();
        if addition.is_empty() {
            return;
        }
        self.filter.push_str(&addition);
        self.selected = 0;
    }
    pub fn backspace_filter(&mut self) {
        if self.filter.pop().is_some() {
            self.selected = 0;
        }
    }
    pub fn clear_filter(&mut self) {
        if !self.filter.is_empty() {
            self.filter.clear();
            self.selected = 0;
        }
    }
    fn index(&self, len: usize) -> usize {
        if len == 0 {
            0
        } else {
            self.selected.min(len - 1)
        }
    }
}

fn searchable(choice: &Choice, label: &str) -> String {
    let identity = match choice {
        Choice::Model(model) => format!(
            "{}:{}",
            model["providerId"].as_str().unwrap_or_default(),
            model["modelId"].as_str().unwrap_or_default()
        ),
        Choice::Mode(mode) => mode.clone(),
        Choice::Session(id) => id.clone(),
    };
    format!("{label} {identity}").to_lowercase()
}

fn filter_input(text: &str) -> String {
    clean_terminal(text)
        .chars()
        .map(|c| if c == '\n' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .collect()
}

#[cfg(test)]
#[path = "selector_tests.rs"]
mod selector_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wrap_preserves_typed_ids_and_bounds_choices() {
        let model = serde_json::json!({"providerId":"personal:fixture","modelId":"vendor:model"});
        let mut s = Selector::new(
            "Models".into(),
            vec![(Choice::Model(model.clone()), "name".into()); 300],
            "session".into(),
            "/model".into(),
        )
        .unwrap();
        assert_eq!(s.options.len(), 200);
        s.move_by(-1);
        assert_eq!(s.selected, 199);
        s.move_by(1);
        assert_eq!(s.choice().unwrap().0, Choice::Model(model));
        assert_eq!(s.draft, "/model");
    }
}
