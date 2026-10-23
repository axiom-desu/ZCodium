//! 一次性 `Method::Command` workflow（`/compact` 的 canonical sendText）。
//!
//! 压缩只走 actor admission：不附带启动附件、不写本地 marker、不扩共享 schema。
//! `type: "compact"` 的 payload 在共享 v4 schema 里是 `z.object({})`，附加指令会被
//! zod strip 语义丢掉；因此这里发 `sendText` + `/compact <args>`，由 core 既有的
//! parse 后归一化改判为 compact 并回填指令。
use crate::{
    flow::{Effects, Progress},
    projection::View,
};
use serde_json::Value;
use zcode_cli_core_api::Method;

pub(crate) struct CommandFlow {
    command: Value,
    /// 被拒绝时要整份交还的原始斜杠输入（主 editor 已清空时）。
    restore: String,
}

impl CommandFlow {
    pub(crate) fn new(command: Value, restore: String) -> Self {
        Self { command, restore }
    }

    pub(crate) fn step(&self) -> (Method, Value) {
        (Method::Command, self.command.clone())
    }

    pub(crate) fn resume(&mut self, view: &mut View, result: Result<Value, String>) -> Progress {
        let message = match result {
            Ok(ack) if ack["status"] == "accepted" => return Progress::Finish(Effects::dirty()),
            Ok(ack) => ack["message"]
                .as_str()
                .or(ack["reasonCode"].as_str())
                .unwrap_or("Command was not accepted")
                .to_owned(),
            Err(error) => error,
        };
        // 失败不伪造成功：主 editor 仍为空时整份交还原输入，已输入的新草稿不被覆盖。
        if view.editor.text().is_empty() {
            view.editor.replace_all(&self.restore);
        }
        Progress::Finish(Effects::error(message))
    }
}
