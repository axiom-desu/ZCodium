//! snapshot / resync workflow：gaprepair 的唯一只读回拉。
//!
//! 只发一次 TopicSnapshot，回包到达后应用；失败不做退避重试，避免 busy-loop 风暴——
//! 后续真实 delta gap 会重新置位 `resync`，由事件驱动再次修复。
use crate::{
    flow::{Effects, Progress},
    projection::View,
};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

pub(crate) struct Snapshot {
    topic: String,
}

impl Snapshot {
    pub(crate) fn new(view: &View) -> Option<Self> {
        // 没有会话就没有可回拉的主题：不伪造 topic。
        (!view.session.is_empty()).then(|| Self {
            topic: format!("conversation/{}", view.session),
        })
    }

    pub(crate) fn step(&self) -> (Method, Value) {
        (
            Method::TopicSnapshot,
            json!({"topic":self.topic,"forceSnapshot":true}),
        )
    }

    pub(crate) fn resume(&mut self, view: &mut View, result: Result<Value, String>) -> Progress {
        match result {
            Ok(value) => {
                view.snapshot(&value["snapshot"]);
                Progress::Finish(Effects::dirty())
            }
            Err(error) => {
                // 明确解除本轮重试意图：新增 delta gap 才是下一次修复的唯一触发点。
                view.resync = false;
                Progress::Finish(Effects::error(error))
            }
        }
    }
}
