use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Choice {
    Model(Value),
    Mode(String),
    Session(String),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Selector {
    pub title: String,
    pub options: Vec<(Choice, String)>,
    pub selected: usize,
    pub owner: String,
    pub draft: String,
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
            .take(200)
            .map(|(action, label)| {
                let label = crate::editor::sanitize(&label).replace(['\n', '\t'], " ");
                (action, label.chars().take(512).collect())
            })
            .collect::<Vec<_>>();
        (!options.is_empty()).then_some(Self {
            title,
            options,
            selected: 0,
            owner,
            draft,
        })
    }
    pub fn move_by(&mut self, delta: isize) {
        if !self.options.is_empty() {
            self.selected =
                (self.selected as isize + delta).rem_euclid(self.options.len() as isize) as usize;
        }
    }
    pub fn choice(&self) -> Option<&(Choice, String)> {
        self.options.get(self.selected)
    }
}
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
