//! 控制消息的唯一有界 outbox（spec §输入与草稿规则「满通道」）。
//!
//! `HostReply`/`TopicReleased` 不是 admission 请求：满通道时既不能 await 容量，也不能
//! 丢掉或乱序。这里按 FIFO 排队并在每轮主循环用 `try_send` 重试；超过上限时明确拒绝
//! 新消息（而不是悄悄丢弃最旧的一条），由调用方给出可见提示。
use crate::{
    client::Client,
    client_operations::OpTickets,
    client_reads::ReadTickets,
    flow::{Continuations, Effects},
    operations::Operations,
    projection::{Pending, View},
};
use serde_json::Value;
use std::collections::VecDeque;
use tokio::sync::mpsc;
use zcode_cli_core_api::ClientMsg;

/// 待发送控制消息上限：远大于单轮真实消息量，只用来兜底异常。
const MAX_CONTROL: usize = 16;

#[derive(Default)]
pub(crate) struct ControlOutbox {
    queue: VecDeque<ClientMsg>,
}

impl ControlOutbox {
    /// 入队并立即尝试发送；返回 `false` 表示队列已满（调用方必须提示而不是假装成功）。
    pub(crate) fn push(&mut self, message: ClientMsg) -> bool {
        if self.queue.len() >= MAX_CONTROL {
            return false;
        }
        self.queue.push_back(message);
        true
    }

    /// 保持顺序地尽量发送：满通道留在队首，下一轮继续。
    ///
    /// 返回 `false` 仅表示运行时通道已关闭（收尾/宿主已退出）；此时队列原样保留，
    /// 调用方必须按生命周期错误收尾，不能把未发送的 HostReply/TopicReleased 当成成功。
    pub(crate) fn flush(&mut self, to: &mpsc::Sender<ClientMsg>) -> bool {
        while let Some(message) = self.queue.pop_front() {
            match to.try_send(message) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(message)) => {
                    self.queue.push_front(message);
                    return true;
                }
                Err(mpsc::error::TrySendError::Closed(message)) => {
                    self.queue.push_front(message);
                    return false;
                }
            }
        }
        true
    }
}

/// 应用一次 workflow 结束的副作用：release 走同一 outbox，错误变成可见通知。
///
/// outbox 满/通道关闭时不能静默丢弃 release，也不能提示后假成功：显式错误让用户
/// 知道旧 topic 仍被订阅或运行时已断开。
pub(crate) fn apply(client: &mut Client<'_>, view: &mut View, effects: Effects) -> bool {
    let Effects {
        dirty,
        error,
        release,
    } = effects;
    if let Some(topic) = release
        && !client.release_topic(topic)
    {
        let note = view
            .text(
                "Error: too many pending control messages; the previous session topic could not be released.",
                "错误：待发送的控制消息过多；上一会话的 topic 未能释放。",
            )
            .to_owned();
        view.push(&note);
    }
    if let Some(error) = error {
        let note = format!("Error: {error}");
        view.push(&note);
    }
    if !client.flush_control() {
        let note = view
            .text(
                "Error: the runtime channel is closed; pending control messages could not be delivered.",
                "错误：运行时通道已关闭；待发送的控制消息无法送达。",
            )
            .to_owned();
        view.push(&note);
    }
    dirty
}

impl<'a> Client<'a> {
    /// 当前在飞 workflow / draft 的唯一派生摘要（只给 UI 显示，不是业务事实）。
    pub(crate) fn pending_label(&self, operations: &Operations) -> Option<Pending> {
        pending_label(&self.flows, operations)
    }

    /// 旧世代的只读/operation 票据与完成结果只保留当前 generation。
    ///
    /// 统一入口：两个票据集必须用同一个 generation 收敛，不能一个已释放、另一个还占槽。
    pub(crate) fn forget_stale(&mut self, view: &View) {
        forget_stale(&mut self.reads, &mut self.operations, view.generation);
    }
}

/// 当前在飞 workflow / draft 的唯一派生摘要（只给 UI 显示，不参与发送决策）。
pub(crate) fn pending_label(flows: &Continuations, operations: &Operations) -> Option<Pending> {
    flows
        .pending()
        .or_else(|| operations.busy().then_some(Pending::Submitting))
}

/// 两个票据集用同一个 generation 收敛旧票据，避免一个已释放、另一个还占槽。
pub(crate) fn forget_stale(reads: &mut ReadTickets, operations: &mut OpTickets, generation: u64) {
    reads.forget_stale(generation);
    operations.forget_stale(generation);
}

/// 终端不支持 Host 专用请求时的唯一处理：回包走有界 outbox，满/通道关闭都显式报错，
/// 不提示后假装成功，也不静默丢弃。
pub(crate) fn host_request_unavailable(client: &mut Client<'_>, view: &mut View, id: String) {
    let queued = client.control.push(ClientMsg::HostReply {
        id,
        result: Value::Null,
    });
    let open = client.flush_control();
    if !queued {
        let note = view
            .text(
                "Error: too many pending host replies; this Host request could not be answered.",
                "错误：待发送的 host 回包过多；本次 Host 请求未能应答。",
            )
            .to_owned();
        view.push(&note);
    }
    if !open {
        let note = view
            .text(
                "Error: the runtime channel is closed; pending Host replies could not be delivered.",
                "错误：运行时通道已关闭；待发送的 Host 回包无法送达。",
            )
            .to_owned();
        view.push(&note);
    }
    view.push(view.text(
        "Host-only request unavailable in terminal.",
        "终端不支持该 Host 专用请求。",
    ));
}
