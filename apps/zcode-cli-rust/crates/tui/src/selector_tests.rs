use crate::selector::{Choice, MAX_FILTER_CHARS, Selector};
use serde_json::json;

fn selector() -> Selector {
    Selector::new(
        "Choices".into(),
        vec![
            (
                Choice::Model(json!({"providerId":"personal:fixture","modelId":"vendor:model"})),
                "personal:fixture / vendor:model".into(),
            ),
            (
                Choice::Model(json!({"providerId":"openai","modelId":"gpt-5"})),
                "openai / gpt-5".into(),
            ),
            (Choice::Mode("plan".into()), "plan".into()),
            (Choice::Session("s-42".into()), "文档 · s-42".into()),
        ],
        "s".into(),
        "/model".into(),
    )
    .unwrap()
}

#[test]
fn filter_is_case_insensitive_and_choice_keeps_the_original_typed_value() {
    let mut s = selector();
    s.push_filter("GPT");
    assert_eq!(s.selected, 0);
    let filtered = s.filtered_options();
    assert_eq!(filtered.len(), 1);
    assert_eq!(
        filtered[0].0,
        Choice::Model(json!({"providerId":"openai","modelId":"gpt-5"}))
    );
    assert_eq!(s.choice().unwrap().1, "openai / gpt-5");
    // provider/model 用冒号键入时仍能匹配 typed id，而不是依赖展示用的空格。
    s.clear_filter();
    s.push_filter("personal:fixture:vendor:model");
    assert_eq!(
        s.choice().unwrap().0,
        Choice::Model(json!({"providerId":"personal:fixture","modelId":"vendor:model"}))
    );
    // 会话可筛选 title 或 id。
    s.clear_filter();
    s.push_filter("文档");
    assert_eq!(s.choice().unwrap().0, Choice::Session("s-42".into()));
    s.clear_filter();
    s.push_filter("S-42");
    assert_eq!(s.choice().unwrap().0, Choice::Session("s-42".into()));
}

#[test]
fn edits_reset_selection_and_backspace_deletes_one_unicode_character() {
    let mut s = selector();
    s.move_by(3);
    assert_eq!(s.selected, 3);
    s.push_filter("文");
    assert_eq!(s.selected, 0);
    s.push_filter("档🙂");
    assert_eq!(s.filter, "文档🙂");
    s.backspace_filter();
    assert_eq!(s.filter, "文档");
    s.backspace_filter();
    assert_eq!(s.filter, "文");
    s.clear_filter();
    assert_eq!(s.filter, "");
    assert_eq!(s.selected, 0);
}

#[test]
fn filter_is_bounded_to_256_unicode_characters() {
    let mut s = selector();
    s.push_filter(&"界".repeat(300));
    assert_eq!(s.filter.chars().count(), MAX_FILTER_CHARS);
    s.push_filter("tail");
    assert_eq!(s.filter.chars().count(), MAX_FILTER_CHARS);
    assert!(s.filter.chars().all(|c| c == '界'));
}

#[test]
fn filter_input_strips_ansi_and_osc_sequences() {
    let mut s = selector();
    s.push_filter("\x1b[31mopen\x1b]0;title\x07ai\x1b\\");
    assert_eq!(s.filter, "openai");
}

#[test]
fn empty_result_is_safe_and_clear_restores_the_full_list() {
    let mut s = selector();
    s.selected = 2;
    assert_eq!(s.filtered_options().len(), 4);
    s.push_filter("no-such-choice");
    assert!(s.choice().is_none());
    s.move_by(1);
    s.move_by(-9);
    assert_eq!(s.selected, 0);
    s.clear_filter();
    assert_eq!(s.filtered_options().len(), 4);
    assert_eq!(s.filtered_options()[2].0, Choice::Mode("plan".into()));
}

#[test]
fn existing_option_and_label_bounds_are_preserved() {
    let model = json!({"providerId":"p","modelId":"m"});
    let s = Selector::new(
        "Models".into(),
        vec![(Choice::Model(model.clone()), "x".repeat(600)); 300],
        "s".into(),
        "/model".into(),
    )
    .unwrap();
    assert_eq!(s.options.len(), 200);
    assert_eq!(s.options[0].1.chars().count(), 512);
    assert_eq!(s.options[0].0, Choice::Model(model));
    // 过滤只借用原始 options，不复制 typed choice。
    assert_eq!(s.filtered_options()[0].0, s.options[0].0);
}

#[test]
fn popup_shows_the_filter_line_and_a_localized_empty_result() {
    use ratatui::{Terminal, backend::TestBackend};
    fn render(selector: &Selector, zh: bool) -> String {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| {
                crate::presentation_panels::draw_selector_localized(
                    frame,
                    frame.area(),
                    selector,
                    zh,
                );
            })
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .filter(|symbol| !symbol.trim().is_empty())
            .collect()
    }
    let mut s = selector();
    s.push_filter("s-42");
    let text = render(&s, true);
    assert!(text.contains("筛选:s-42▌"), "{text}");
    assert!(!text.contains("openai/gpt-5"));
    s.clear_filter();
    s.push_filter("missing");
    assert!(render(&s, true).contains("没有匹配的选项"));
    assert!(render(&s, false).contains("Nomatchingchoices"));
}
