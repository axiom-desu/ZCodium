//! picker 会话列表 workflow：一次 SessionList，回包到达后构造 selector。
//!
//! 迟到回包不得清掉用户新开菜单/新草稿：owner 会话或世代变化就直接丢弃效果。
//! `/model` 与 `/mode` 的候选全部来自本地已确认快照，不需要请求，因此不经本模块。
use crate::{
    flow::{Effects, Progress},
    picker,
    projection::View,
    selector::Selector,
};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

pub(crate) struct PickerOpen {
    workspace: Value,
    text: String,
    owner: String,
}

impl PickerOpen {
    pub(crate) fn new(view: &View, workspace: &Value, text: &str) -> Self {
        Self {
            workspace: workspace.clone(),
            text: text.to_owned(),
            owner: view.session.clone(),
        }
    }

    pub(crate) fn step(&self) -> (Method, Value) {
        (Method::SessionList, json!({"workspace": self.workspace}))
    }

    pub(crate) fn resume(&mut self, view: &mut View, result: Result<Value, String>) -> Progress {
        let data = match result {
            Ok(data) => data,
            Err(error) => return Progress::Finish(Effects::error(error)),
        };
        // 迟到：会话已换（含同 id 重开的世代推进）或用户已打开新菜单就不清掉新菜单/新草稿。
        if self.owner != view.session || view.selector.is_some() {
            return Progress::Finish(Effects::default());
        }
        let options = picker::session_options(view, &data);
        let selector = Selector::new(
            view.text("Sessions", "会话").to_owned(),
            options,
            self.owner.clone(),
            self.text.clone(),
        );
        if selector.is_none() {
            view.push(view.text("No choices available", "暂无可选项"));
            return Progress::Finish(Effects::dirty());
        }
        view.selector = selector.map(|mut selector| {
            picker::select_current(view, &mut selector);
            selector
        });
        Progress::Finish(Effects::dirty())
    }
}
