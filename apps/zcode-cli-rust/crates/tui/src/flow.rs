//! 非阻塞 workflow 续步状态机（spec cli-rust-tui-responsive-operations §接口与模块边界）。
//!
//! 每条 workflow 是“一请求一步”的 typed 状态机：调用方只 `begin` 一次（本地登记，
//! 有界 `try_send` 立刻发第一步），回包到达后 [`Continuations::resume`] 推进到下一步，
//! 全程不 await 新的 ACK、不 await 通道容量，也不复制第二份 UI 状态。
//!
//! 槽位：`Mutation` 侧同时只允许一条 UI mutation workflow（boot/setting/queue/picker
//! 确认/compact），`Read` 侧同时只允许一条只读 workflow（session 列表、snapshot resync）。
//! 通道满时把已算好的下一步留在唯一 staged 槽里按序重试，绝不丢请求。
use crate::{
    flow_boot::Boot,
    flow_command::CommandFlow,
    flow_picker::PickerOpen,
    flow_queue::QueueFlow,
    flow_session_list::SessionList,
    flow_setting::Setting,
    flow_snapshot::Snapshot,
    projection::{Pending, View},
};
use serde_json::Value;
use zcode_cli_core_api::Method;

/// workflow 的占用槽：UI mutation 与只读各单飞，互不阻塞。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Slot {
    Mutation,
    Read,
}

/// 一步推进的结果；只有 `Finish` 会释放槽位。
pub(crate) enum Progress {
    /// 进入下一步，需要发送 `Flow::step` 给出的请求。
    Next,
    /// 结束；View 效果已在 resume 内应用，或给出明确错误。
    Finish(Effects),
}

/// 一次 workflow 结束时的非 View 副作用：release 由 Client 走有界控制 outbox 保序发送。
#[derive(Default)]
pub(crate) struct Effects {
    pub dirty: bool,
    pub error: Option<String>,
    pub release: Option<String>,
}

impl Effects {
    pub(crate) fn dirty() -> Self {
        Self {
            dirty: true,
            ..Self::default()
        }
    }
    pub(crate) fn error(message: impl Into<String>) -> Self {
        Self {
            dirty: true,
            error: Some(message.into()),
            ..Self::default()
        }
    }
}

/// 旧世代 workflow 被撤销时的可见提示；草稿不自动删除，也不会自动重发。
pub(crate) fn cancel_note(view: &View, pending: Pending) -> String {
    match pending {
        Pending::Opening => view
            .text(
                "The session changed while opening; the pending open intent was cancelled. Use /resume or /new again.",
                "打开期间会话已变化；待处理的打开意图已取消。请重新使用 /resume 或 /new。",
            )
            .to_owned(),
        Pending::Sessions => view
            .text(
                "The session changed while loading sessions; the list request was cancelled. Your draft was kept.",
                "加载会话列表期间会话已变化；请求已取消。草稿已保留。",
            )
            .to_owned(),
        Pending::Setting => view
            .text(
                "The session changed while applying a setting; the pending change was cancelled. Your draft was kept.",
                "应用设置期间会话已变化；待处理的修改已取消。草稿已保留。",
            )
            .to_owned(),
        Pending::Queue => view
            .text(
                "The session changed while saving a queue change; the pending save was cancelled. Your draft was kept.",
                "保存队列变更期间会话已变化；待处理的保存已取消。草稿已保留。",
            )
            .to_owned(),
        Pending::Command => view
            .text(
                "The session changed while the command was in flight; its result is unknown and it was not resent.",
                "命令在飞时会话已变化；结果未知，未自动重发。",
            )
            .to_owned(),
        Pending::Syncing | Pending::Submitting => view
            .text(
                "The session changed while an operation was in flight; its result is unknown and it was not resent.",
                "操作在飞时会话已变化；结果未知，未自动重发。",
            )
            .to_owned(),
    }
}

/// 所有已知 workflow；每一步的请求由 `step(&View)` 从本地已确认事实推导。
pub(crate) enum Flow {
    Boot(Boot),
    SessionList(SessionList),
    Setting(Setting),
    Queue(QueueFlow),
    Picker(PickerOpen),
    Snapshot(Snapshot),
    Command(CommandFlow),
}

impl Flow {
    pub(crate) fn slot(&self) -> Slot {
        match self {
            Self::SessionList(_) | Self::Picker(_) | Self::Snapshot(_) => Slot::Read,
            Self::Boot(_) | Self::Setting(_) | Self::Queue(_) | Self::Command(_) => Slot::Mutation,
        }
    }

    /// 用户可见的在飞摘要；只做状态映射，不携带任何业务事实。
    pub(crate) fn pending(&self) -> Pending {
        match self {
            Self::Boot(_) => Pending::Opening,
            Self::SessionList(_) | Self::Picker(_) => Pending::Sessions,
            Self::Setting(_) => Pending::Setting,
            Self::Queue(_) => Pending::Queue,
            Self::Snapshot(_) => Pending::Syncing,
            Self::Command(_) => Pending::Command,
        }
    }

    /// 当前这一步的请求；只从本地已确认事实推导，不猜 id。
    fn step(&self, view: &View) -> (Method, Value) {
        match self {
            Self::Boot(flow) => flow.step(),
            Self::SessionList(flow) => flow.step(),
            Self::Setting(flow) => flow.step(view),
            Self::Queue(flow) => flow.step(view),
            Self::Picker(flow) => flow.step(),
            Self::Snapshot(flow) => flow.step(),
            Self::Command(flow) => flow.step(),
        }
    }

    fn resume(&mut self, view: &mut View, result: Result<Value, String>) -> Progress {
        match self {
            Self::Boot(flow) => flow.resume(view, result),
            Self::SessionList(flow) => flow.resume(view, result),
            Self::Setting(flow) => flow.resume(view, result),
            Self::Queue(flow) => flow.resume(view, result),
            Self::Picker(flow) => flow.resume(view, result),
            Self::Snapshot(flow) => flow.resume(view, result),
            Self::Command(flow) => flow.resume(view, result),
        }
    }
}

/// 一条在飞 workflow：epoch 是意图身份，generation 是发起时的票据世代。
struct Active {
    flow: Flow,
    epoch: u64,
    generation: u64,
    /// 已算好但还没发出的下一步（通道满时唯一有序缓冲）。
    staged: Option<(Method, Value)>,
    /// 已发出、等待回包的 token。
    token: Option<u64>,
}

/// 待发送的下一步；`take_staged` 取出后必须发送成功或 `restore` 回来。
pub(crate) struct Staged {
    pub slot: Slot,
    pub epoch: u64,
    pub generation: u64,
    pub method: Method,
    pub params: Value,
}

#[derive(Default)]
pub(crate) struct Continuations {
    mutation: Option<Active>,
    read: Option<Active>,
    epoch: u64,
}

impl Continuations {
    fn slot_ref(&self, slot: Slot) -> &Option<Active> {
        match slot {
            Slot::Mutation => &self.mutation,
            Slot::Read => &self.read,
        }
    }

    fn slot_mut(&mut self, slot: Slot) -> &mut Option<Active> {
        match slot {
            Slot::Mutation => &mut self.mutation,
            Slot::Read => &mut self.read,
        }
    }

    pub(crate) fn busy(&self, slot: Slot) -> bool {
        self.slot_ref(slot).is_some()
    }

    pub(crate) fn mutation_busy(&self) -> bool {
        self.mutation.is_some()
    }

    #[cfg(test)]
    pub(crate) fn any_busy(&self) -> bool {
        self.mutation.is_some() || self.read.is_some()
    }

    /// 登记一条 workflow 并算出第一步；槽位已占用时明确拒绝（不排队、不覆盖）。
    pub(crate) fn begin(&mut self, view: &View, flow: Flow) -> bool {
        let slot = flow.slot();
        if self.slot_ref(slot).is_some() {
            return false;
        }
        self.epoch = self.epoch.wrapping_add(1);
        let active = Active {
            staged: Some(flow.step(view)),
            flow,
            epoch: self.epoch,
            generation: view.generation,
            token: None,
        };
        *self.slot_mut(slot) = Some(active);
        true
    }

    /// 取出待发送的下一步（有界：一次一条，Mutation 优先）。
    pub(crate) fn take_staged(&mut self) -> Option<Staged> {
        for slot in [Slot::Mutation, Slot::Read] {
            let Some(active) = self.slot_mut(slot).as_mut() else {
                continue;
            };
            let Some((method, params)) = active.staged.take() else {
                continue;
            };
            return Some(Staged {
                slot,
                epoch: active.epoch,
                generation: active.generation,
                method,
                params,
            });
        }
        None
    }

    /// 通道满：把下一步放回同一 workflow，下一轮按序重试，不丢请求。
    pub(crate) fn restore(&mut self, staged: Staged) {
        if let Some(active) = self.slot_mut(staged.slot).as_mut() {
            active.staged = Some((staged.method, staged.params));
        }
    }

    pub(crate) fn mark_sent(&mut self, slot: Slot, token: u64) {
        if let Some(active) = self.slot_mut(slot).as_mut() {
            active.token = Some(token);
        }
    }

    /// 运行时消失：撤销该 workflow，避免槽位永久占用。
    pub(crate) fn drop_slot(&mut self, slot: Slot) {
        *self.slot_mut(slot) = None;
    }

    /// 只释放身份仍匹配的旧世代 workflow；不能误删同槽的新 epoch。
    pub(crate) fn drop_slot_if(&mut self, slot: Slot, epoch: u64) {
        if self
            .slot_ref(slot)
            .as_ref()
            .is_some_and(|active| active.epoch == epoch)
        {
            *self.slot_mut(slot) = None;
        }
    }

    /// 切 session / TopicClosed：旧世代的 workflow（含未发送的 staged）一律失效。
    ///
    /// 返回被撤销的 workflow 类型，调用方必须把用户可感知的意图显式告知用户——
    /// 旧世代效果可以丢弃，但不能让用户刚输入的命令无声消失。
    pub(crate) fn invalidate(&mut self, generation: u64) -> Vec<Pending> {
        let mut dropped = Vec::new();
        for slot in [Slot::Mutation, Slot::Read] {
            let stale = self
                .slot_ref(slot)
                .as_ref()
                .is_some_and(|active| active.generation != generation);
            if stale && let Some(active) = self.slot_mut(slot).take() {
                dropped.push(active.flow.pending());
            }
        }
        dropped
    }

    /// 当前在飞 workflow 的派生摘要（Mutation 优先，与发送顺序一致）。
    pub(crate) fn pending(&self) -> Option<Pending> {
        for slot in [Slot::Mutation, Slot::Read] {
            if let Some(active) = self.slot_ref(slot).as_ref() {
                return Some(active.flow.pending());
            }
        }
        None
    }

    /// 回包结算：epoch 或世代不匹配就是迟到的旧效果，只丢票、不写 View。
    ///
    /// 必须先校验身份再 `take`：旧回复不得把槽里已经登记的新 workflow（新 epoch）
    /// 一并取走，否则当前新意图会被旧回包无声释放。
    pub(crate) fn resume(
        &mut self,
        view: &mut View,
        slot: Slot,
        epoch: u64,
        generation: u64,
        result: Result<Value, String>,
    ) -> Effects {
        let identity_matches = self.slot_ref(slot).as_ref().is_some_and(|active| {
            active.epoch == epoch
                && active.generation == view.generation
                && generation == view.generation
        });
        if !identity_matches {
            return Effects::default();
        }
        let Some(mut active) = self.slot_mut(slot).take() else {
            return Effects::default();
        };
        active.token = None;
        match active.flow.resume(view, result) {
            Progress::Next => {
                active.staged = Some(active.flow.step(view));
                active.generation = view.generation;
                *self.slot_mut(slot) = Some(active);
                Effects::default()
            }
            Progress::Finish(effects) => effects,
        }
    }
}

#[cfg(test)]
#[path = "flow_continuation_tests.rs"]
mod continuation_tests;
