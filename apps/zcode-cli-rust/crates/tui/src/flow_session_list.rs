//! `/sessions` 的只读列表 workflow：一次 SessionList，回包到达后投影成通知行。
use crate::{
    flow::{Effects, Progress},
    projection::View,
};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

pub(crate) struct SessionList {
    workspace: Value,
}

impl SessionList {
    pub(crate) fn new(workspace: &Value) -> Self {
        Self {
            workspace: workspace.clone(),
        }
    }

    pub(crate) fn step(&self) -> (Method, Value) {
        (Method::SessionList, json!({"workspace": self.workspace}))
    }

    pub(crate) fn resume(&mut self, view: &mut View, result: Result<Value, String>) -> Progress {
        match result {
            Ok(data) => {
                for session in data["sessions"].as_array().into_iter().flatten() {
                    view.push(&format!(
                        "{} {}",
                        session["sessionId"].as_str().unwrap_or("?"),
                        session["title"].as_str().unwrap_or("")
                    ));
                }
                Progress::Finish(Effects::dirty())
            }
            Err(error) => Progress::Finish(Effects::error(error)),
        }
    }
}
