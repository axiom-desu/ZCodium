//! Paste 的真实入口回归（`Event::Paste` 与测试共用 `transport::paste_into`）。
//!
//! 关键事实：选择器 filter 需要原始 ESC 才能剥离 ANSI/OSC；编辑器草稿则必须
//! 把控制字符替换掉。两条路径不能共用一次 `sanitize`。
use crate::{
    projection::View,
    selector::{Choice, Selector},
    transport::paste_into,
};
use serde_json::json;

fn model_selector() -> Selector {
    Selector::new(
        "Models".into(),
        vec![(
            Choice::Model(json!({"providerId":"openai","modelId":"gpt-5"})),
            "openai / gpt-5".into(),
        )],
        "s1".into(),
        "/model".into(),
    )
    .unwrap()
}

#[test]
fn selector_paste_reaches_filter_as_raw_text_and_strips_ansi_osc() {
    let mut view = View {
        selector: Some(model_selector()),
        ..View::default()
    };
    // 复制终端里带颜色和窗口标题的文本时，ESC 序列是原文；filter 只保留可见字符。
    paste_into(&mut view, "\u{1b}[31mopen\u{1b}]0;title\u{7}ai\u{1b}\\");
    let selector = view.selector.as_ref().unwrap();
    assert_eq!(selector.filter, "openai");
    assert!(view.editor.text().is_empty(), "选择器 paste 不进 editor");
    assert_eq!(
        selector.choice().unwrap().0,
        Choice::Model(json!({"providerId":"openai","modelId":"gpt-5"}))
    );
    assert_eq!(selector.draft, "/model", "Esc 仍能恢复原草稿");
}

#[test]
fn selector_paste_never_leaves_control_bytes_in_the_filter() {
    let mut view = View {
        selector: Some(model_selector()),
        ..View::default()
    };
    paste_into(&mut view, "gpt\u{7}\u{0}\u{1b}\u{1b}[32m");
    let selector = view.selector.as_ref().unwrap();
    assert!(selector.filter.starts_with("gpt"), "{}", selector.filter);
    assert!(!selector.filter.chars().any(char::is_control));
    assert_eq!(view.editor.text(), "");
}

#[test]
fn editor_paste_still_replaces_control_characters() {
    let mut view = View::default();
    paste_into(&mut view, "ok\u{1b}[31m\u{7}\nnext");
    assert!(view.selector.is_none());
    assert_eq!(view.editor.text(), "ok\u{fffd}[31m\u{fffd}\nnext");
    assert!(
        !view
            .editor
            .text()
            .chars()
            .any(|c| c.is_control() && c != '\n')
    );
}
