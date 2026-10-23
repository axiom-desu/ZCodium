//! setting workflow：setter ACK 后在同一 workflow 内续一步 TopicSnapshot。
//!
//! 旧 setter 只广播 HostNotification，终端不消费 Host 的业务投影；这里仍从 actor 回拉
//! 快照，保证菜单与带参命令共用一条写入路径且展示已提交事实，而不是手改 UI config。
//! 快照是同一 workflow 的续步，不是新的请求来源，也不伪造 setting 结果。
use crate::{
    flow::{Effects, Progress},
    projection::View,
};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

enum Stage {
    Apply,
    Snapshot,
}

pub(crate) struct Setting {
    method: Method,
    params: Value,
    stage: Stage,
    /// 发起时打开的菜单归属：成功后只关闭这一份，迟到的旧回包不关新菜单。
    close_selector: Option<(String, u64)>,
}

impl Setting {
    /// `params` 必须是调用方按当前会话构造好的原样参数（sessionId/model/thoughtLevel）。
    pub(crate) fn new(
        method: Method,
        params: Value,
        close_selector: Option<(String, u64)>,
    ) -> Self {
        Self {
            method,
            params,
            stage: Stage::Apply,
            close_selector,
        }
    }

    fn settle_local(&self, view: &mut View) {
        if let Some((session, generation)) = &self.close_selector
            && view.generation == *generation
            && view.selector.as_ref().is_some_and(|s| &s.owner == session)
        {
            view.selector = None;
        }
    }

    pub(crate) fn step(&self, view: &View) -> (Method, Value) {
        match self.stage {
            Stage::Apply => (self.method, self.params.clone()),
            Stage::Snapshot => (
                Method::TopicSnapshot,
                json!({"topic":format!("conversation/{}", view.session),"forceSnapshot":true}),
            ),
        }
    }

    pub(crate) fn resume(&mut self, view: &mut View, result: Result<Value, String>) -> Progress {
        let value = match result {
            Ok(value) => value,
            Err(error) => return Progress::Finish(Effects::error(error)),
        };
        match self.stage {
            Stage::Apply => {
                // setter 的返回值不承载会话事实；真实配置只认随后的快照。
                self.stage = Stage::Snapshot;
                Progress::Next
            }
            Stage::Snapshot => {
                view.snapshot(&value["snapshot"]);
                self.settle_local(view);
                Progress::Finish(Effects::dirty())
            }
        }
    }
}
