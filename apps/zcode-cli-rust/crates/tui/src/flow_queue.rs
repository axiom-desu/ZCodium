//! queue mutation workflow：带 CAS 基线的 `Method::Command` → 同一 workflow 续一步快照。
//!
//! 队列事实只来自 actor：这里不插本地 user row、不改 `state.queue.items`，accepted 后
//! 回拉快照。stale/拒绝保留原草稿与选择器，并原样带出 actor 的 reasonCode。
use crate::{
    flow::{Effects, Progress},
    projection::View,
    queue_state,
};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

enum Stage {
    Mutate,
    Snapshot,
}

/// 本次保存所发的 queue item 版本：迟到成功只能结算这一版，不能清掉之后的编辑。
pub(crate) struct SentEdit {
    pub queue_item_id: String,
    pub revision: u64,
    pub log_epoch: String,
    /// 发往 actor 的 canonical 正文（trim 后），用于核对 server 队列事实。
    pub text: String,
    /// 提交时 editor 的原始正文：结算本地草稿必须 exact 比较，不能把新敲的空格/换行当清稿。
    pub raw_editor_text: String,
    pub generation: u64,
}

/// 提交成功后要关闭的本地菜单归属：只关发起时那一份，不关用户新开的。
pub(crate) struct Owned {
    pub session: String,
    pub generation: u64,
}

pub(crate) struct QueueFlow {
    command: Value,
    stage: Stage,
    sent_edit: Option<SentEdit>,
    close_selector: Option<Owned>,
}

impl QueueFlow {
    /// `command` 是已经带好 `baseRevision`/`baseLogEpoch` 的完整信封。
    pub(crate) fn new(
        command: Value,
        sent_edit: Option<SentEdit>,
        close_selector: Option<Owned>,
    ) -> Self {
        Self {
            command,
            stage: Stage::Mutate,
            sent_edit,
            close_selector,
        }
    }

    pub(crate) fn step(&self, view: &View) -> (Method, Value) {
        match self.stage {
            Stage::Mutate => (Method::Command, self.command.clone()),
            Stage::Snapshot => (
                Method::TopicSnapshot,
                json!({"topic":format!("conversation/{}", view.session),"forceSnapshot":true}),
            ),
        }
    }

    pub(crate) fn resume(&mut self, view: &mut View, result: Result<Value, String>) -> Progress {
        match self.stage {
            Stage::Mutate => {
                let ack = match result {
                    Ok(ack) => ack,
                    Err(error) => return Progress::Finish(Effects::error(error)),
                };
                match ack["status"].as_str().unwrap_or_default() {
                    "accepted" | "duplicate" | "noop" => {
                        self.settle_local(view);
                        self.stage = Stage::Snapshot;
                        Progress::Next
                    }
                    // actor 的 reasonCode 是这次拒绝的真实原因，不能换成本地笼统提示。
                    "stale" => {
                        let code = ack["reasonCode"].as_str().unwrap_or("stale");
                        Progress::Finish(Effects::error(
                            queue_state::local(
                                view,
                                format!(
                                    "The queue changed before this action ({code}); reopen /queue and retry."
                                ),
                                format!("队列在你操作前已变化（{code}）；请重新打开 /queue 再试。"),
                            )
                            .to_string(),
                        ))
                    }
                    _ => {
                        let code = ack["reasonCode"].as_str().unwrap_or_default();
                        let message = ack["message"]
                            .as_str()
                            .filter(|message| !message.is_empty())
                            .unwrap_or(code);
                        Progress::Finish(Effects::error(
                            queue_state::local(
                                view,
                                format!("Queue command was not applied: {message}"),
                                format!("队列命令未生效：{message}"),
                            )
                            .to_string(),
                        ))
                    }
                }
            }
            Stage::Snapshot => match result {
                Ok(value) => {
                    if !view.snapshot(&value["snapshot"]) {
                        return Progress::Finish(Effects::error(
                            queue_state::local(
                                view,
                                "The queue refresh returned an invalid snapshot; your draft was kept."
                                    .into(),
                                "队列刷新返回了无效快照；草稿已保留。".into(),
                            )
                            .to_string(),
                        ));
                    }
                    // 保存期间继续编辑的那份稿：只有快照仍证明是同一版 committed item
                    // 才能续写基线；否则只保稿并明确冲突，不自动重试。
                    if !self.rebase_retained_edit(view) {
                        let note = queue_state::local(
                            view,
                            "The queued item changed before the save was confirmed; your newer edit was kept. Reopen /queue and review it; it was not retried."
                                .into(),
                            "保存确认前排队项已变化；较新的编辑已保留。请重新打开 /queue 复核；未自动重试。"
                                .into(),
                        )
                        .to_string();
                        view.push(&note);
                    }
                    Progress::Finish(Effects::dirty())
                }
                Err(error) => Progress::Finish(Effects::error(error)),
            },
        }
    }

    /// 快照仍证明同 id/同世代/同 epoch、仍 queued 且正文等于所发版本时，把保留编辑
    /// 的 CAS 基线推进到真实 committed revision；不改正文/光标/附件，也不自动重发。
    fn rebase_retained_edit(&self, view: &mut View) -> bool {
        let Some(sent) = &self.sent_edit else {
            return true;
        };
        // 保存成功后已正常关闭，或用户已开了另一项的编辑器：都没有需要续基线的保留稿。
        let Some(edit) = view.queue_edit.as_ref() else {
            return true;
        };
        if edit.queue_item_id != sent.queue_item_id {
            return true;
        }
        let epoch = queue_state::log_epoch(view);
        if view.generation != sent.generation || epoch != sent.log_epoch {
            return false;
        }
        let Some(item) = queue_state::find(view, &sent.queue_item_id) else {
            return false;
        };
        if item["dispatch"]["state"].as_str() != Some("queued")
            || item["text"].as_str().unwrap_or_default() != sent.text
        {
            return false;
        }
        let revision = queue_state::revision(view);
        if let Some(edit) = view.queue_edit.as_mut() {
            edit.revision = revision;
            edit.log_epoch = epoch;
        }
        true
    }

    /// 只结算发起时那一份本地 UI：保存期间的新输入、新编辑、新菜单都不受影响。
    fn settle_local(&self, view: &mut View) {
        if let Some(owned) = &self.close_selector
            && view.generation == owned.generation
            && view
                .selector
                .as_ref()
                .is_some_and(|s| s.owner == owned.session)
        {
            view.selector = None;
        }
        if let Some(sent) = &self.sent_edit
            && view.generation == sent.generation
            && view.queue_edit.as_ref().is_some_and(|edit| {
                edit.queue_item_id == sent.queue_item_id
                    && edit.revision == sent.revision
                    // exact 比较原始正文：保存确认前新敲的空格/换行也是用户的改动。
                    && edit.text() == sent.raw_editor_text
            })
        {
            view.queue_edit = None;
        }
    }
}
