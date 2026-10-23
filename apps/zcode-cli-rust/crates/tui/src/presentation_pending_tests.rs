//! 在飞 workflow 摘要的渲染回归：帮助栏必须显示派生的打开/应用/保存状态。
#![allow(clippy::field_reassign_with_default)]

use crate::{
    presentation::{RenderCache, draw},
    projection::View,
};
use ratatui::{Terminal, backend::TestBackend};

fn render(view: &View, width: u16, height: u16, cache: &mut RenderCache) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| draw(frame, view, cache, 0)).unwrap();
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect()
}

#[test]
fn pending_workflow_summary_is_visible_before_the_reply_arrives() {
    let mut view = View::default();
    view.pending = Some(crate::projection::Pending::Opening);
    let mut cache = RenderCache::default();
    let frame = render(&view, 120, 30, &mut cache);
    assert!(frame.contains("Opening session..."), "{frame}");
    // 没有在飞 workflow 时不得留下过期摘要。
    view.pending = None;
    let frame = render(&view, 120, 30, &mut cache);
    assert!(!frame.contains("Opening session..."));
}
