use crate::client_operations::{OpReply, OpTickets};
pub(crate) use crate::client_reads::{QueryKind, ReadReply, ReadTickets};
use crate::flow::{Continuations, Flow, Slot, Staged};
use crate::operations::{OpKind, Operations};
use crate::projection::{Pending, View};
use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, Method, RuntimeError, ServerMsg};

/// 未知 token 只保留有界窗口：迟到的同步回包/已放弃的票据不能无限堆。
const MAX_UNKNOWN_REPLIES: usize = 8;
pub(crate) struct Client<'a> {
    pub to: &'a mpsc::Sender<ClientMsg>,
    from: &'a mut mpsc::Receiver<Vec<ServerMsg>>,
    pending: VecDeque<ServerMsg>,
    replies: HashMap<u64, Result<Value, RuntimeError>>,
    /// 与 `replies` 同步的插入顺序，用来淘汰最旧的未知回包。
    reply_order: VecDeque<u64>,
    /// 只读查询票据与完成队列；与 `token` 共用唯一分配器。
    pub(crate) reads: ReadTickets,
    /// UI mutation / workflow 票据；与 reads 共用同一个 token 分配器与回包分流点。
    pub(crate) operations: OpTickets,
    /// boot/setting/queue/picker/snapshot 的续步状态机（单飞槽位）。
    pub(crate) flows: Continuations,
    /// 唯一的有界控制消息 outbox（HostReply/TopicReleased 保序，不 await 容量）。
    pub(crate) control: crate::client_control::ControlOutbox,
    token: u64,
}
impl<'a> Client<'a> {
    pub fn new(
        to: &'a mpsc::Sender<ClientMsg>,
        from: &'a mut mpsc::Receiver<Vec<ServerMsg>>,
    ) -> Self {
        Self {
            to,
            from,
            pending: VecDeque::new(),
            replies: HashMap::new(),
            reply_order: VecDeque::new(),
            reads: ReadTickets::default(),
            operations: OpTickets::default(),
            flows: Continuations::default(),
            control: crate::client_control::ControlOutbox::default(),
            token: 0,
        }
    }
    /// recv is cancellation safe; the complete batch stays in FIFO even after a matching reply.
    pub async fn next(&mut self) -> Result<ServerMsg> {
        loop {
            if let Some(message) = self.pending.pop_front() {
                return Ok(message);
            }
            self.pending.extend(
                self.from
                    .recv()
                    .await
                    .context("Runtime stopped unexpectedly")?,
            );
        }
    }

    /// 已经到达但还没读的消息；只给测试驱动同一状态机用，生产循环始终 select `next`。
    #[cfg(test)]
    pub(crate) fn try_next(&mut self) -> Option<ServerMsg> {
        if let Some(message) = self.pending.pop_front() {
            return Some(message);
        }
        let batch = self.from.try_recv().ok()?;
        self.pending.extend(batch);
        self.pending.pop_front()
    }

    /// 同步等待回包：现在只有测试使用；生产路径一律走票据/续步（见 `begin_flow`）。
    #[cfg(test)]
    pub async fn call(&mut self, view: &mut View, method: Method, params: Value) -> Result<Value> {
        let expected = self.allocate()?;
        self.to
            .send(ClientMsg::Request {
                token: expected,
                method,
                params,
            })
            .await
            .context("Runtime stopped")?;
        loop {
            if let Some(result) = self.replies.remove(&expected) {
                return result.map_err(Into::into);
            }
            let message = self.next().await?;
            if let ServerMsg::Reply { token, result } = message {
                if token == expected {
                    return result.map_err(Into::into);
                }
                // 同步 call 中穿插的只读回包同样分流，不能吞进永久 replies map。
                self.reply(token, result);
            } else {
                self.observe(view, message).await?;
            }
        }
    }

    fn allocate(&mut self) -> Result<u64> {
        self.token = self
            .token
            .checked_add(1)
            .context("Request token exhausted")?;
        Ok(self.token)
    }

    /// 只读查询：只发送、不等待回复，同一 class 最多一笔在飞或未消费完成结果。
    ///
    /// 同步/不阻塞：队列满时返回 `Ok(false)` 让调用方下一轮重试；只有运行时消失才报错。
    pub fn start_query(
        &mut self,
        view: &View,
        kind: QueryKind,
        method: Method,
        params: Value,
    ) -> Result<bool> {
        // 切 session / TopicClosed 之后旧票据永不回包，必须先释放 class slot。
        self.forget_stale(view);
        if self.reads.busy(kind) {
            return Ok(false);
        }
        let token = self.allocate()?;
        self.reads
            .begin(token, kind, view.session.clone(), view.generation);
        match self.to.try_send(ClientMsg::Request {
            token,
            method,
            params,
        }) {
            Ok(()) => Ok(true),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.reads.cancel(token);
                Ok(false)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.reads.cancel(token);
                Err(anyhow::anyhow!("Runtime stopped"))
            }
        }
    }

    /// 非阻塞发送一条 UI mutation：slot 已由 [`Operations::begin`] 占住。
    ///
    /// 通道满返回 `Ok(None)` 并撤销票据，调用方必须把草稿放回 editor 后重试，
    /// 绝不丢请求后假装发送成功。运行时消失才报错。
    pub fn dispatch_operation(
        &mut self,
        session: &str,
        generation: u64,
        operations: &mut Operations,
        kind: OpKind,
        method: Method,
        params: Value,
    ) -> Result<Option<u64>> {
        // 全局一条 mutation workflow：draft 侧与 FlowMutation 侧双向互斥。
        if !self.operations.draft_ready() || self.flows.mutation_busy() {
            return Ok(None);
        }
        if operations.inflight_kind() != Some(kind) {
            bail!("no matching UI operation is in flight");
        }
        let token = self.allocate()?;
        self.operations.begin_draft(
            token,
            kind,
            session.to_owned(),
            generation,
            operations.epoch(),
        );
        match self.to.try_send(ClientMsg::Request {
            token,
            method,
            params,
        }) {
            Ok(()) => Ok(Some(token)),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.operations.cancel(token);
                Ok(None)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.operations.cancel(token);
                bail!("Runtime stopped")
            }
        }
    }

    /// 登记一条 workflow 并立刻尝试发第一步；槽位已占用时返回 false（不排队）。
    ///
    /// Mutation 与 draft operation 共享一条全局门禁；运行时通道关闭时返回真实错误，
    /// 不把未发出的第一步伪装成成功。
    pub(crate) fn begin_flow(&mut self, view: &View, flow: Flow) -> Result<bool> {
        let slot = flow.slot();
        if slot == Slot::Mutation && view.operations.busy() {
            return Ok(false);
        }
        if !self.operations.flow_ready(slot) || !self.flows.begin(view, flow) {
            return Ok(false);
        }
        let Some(staged) = self.flows.take_staged() else {
            return Ok(true);
        };
        match self.transmit(staged, view) {
            Ok(Some(staged)) => self.flows.restore(staged),
            Ok(None) => {}
            Err(error) => {
                self.flows.drop_slot(slot);
                return Err(error);
            }
        }
        Ok(true)
    }

    /// UI mutation workflow 是否在飞：在飞时普通提交明确拒绝并保留草稿。
    pub(crate) fn mutation_flow_busy(&self) -> bool {
        self.flows.mutation_busy()
    }

    /// 是否有任意 workflow 在飞（只给测试驱动同一状态机使用）。
    #[cfg(test)]
    pub(crate) fn flow_busy(&self) -> bool {
        self.flows.any_busy()
    }

    /// 发送控制 outbox 里所有排队的消息（保序、不 await 容量）。
    ///
    /// 返回 `false` 表示运行时通道已关闭：调用方必须按生命周期错误收尾，
    /// 不能把未发出的 HostReply/TopicReleased 当成已发送。
    pub(crate) fn flush_control(&mut self) -> bool {
        self.control.flush(self.to)
    }

    /// boot 之外的公共控制发送入口：release topic 等由 workflow 结果驱动的消息。
    pub(crate) fn release_topic(&mut self, topic: String) -> bool {
        self.control.push(ClientMsg::TopicReleased { topic })
    }

    pub(crate) fn pump_flows(&mut self, view: &mut View) -> Result<bool> {
        let dropped = self.flows.invalidate(view.generation);
        let mut dirty = !dropped.is_empty();
        for pending in dropped {
            // 旧世代效果可以丢弃，但用户可感知的意图必须留下可见去向（草稿不会被自动删除）。
            // 后台 gaprepair 不是用户命令，撤销时不必用提示打断用户。
            if pending != Pending::Syncing {
                view.push(&crate::flow::cancel_note(view, pending));
            }
        }
        self.forget_stale(view);
        if let Some(staged) = self.flows.take_staged()
            && let Some(staged) = self.transmit(staged, view)?
        {
            self.flows.restore(staged);
        }
        // gaprepair 单飞且同一时刻只一条：重复 gap 不会造成回拉风暴。
        if view.resync
            && !view.session.is_empty()
            && !self.flows.busy(Slot::Read)
            && !self.flows.busy(Slot::Mutation)
            && let Some(flow) = crate::flow_snapshot::Snapshot::new(view)
        {
            self.begin_flow(view, Flow::Snapshot(flow))?;
            dirty = true;
        }
        if !self.flush_control() {
            anyhow::bail!("Runtime stopped");
        }
        // 可见摘要每轮从在飞状态派生；不持久化，也不参与发送决策。
        view.pending = self.pending_label(&view.operations);
        Ok(dirty)
    }

    /// workflow 回包结算：按 epoch/generation 归属推进续步，迟到效果只丢票不写 View。
    pub(crate) fn resume_flow(
        &mut self,
        view: &mut View,
        slot: Slot,
        epoch: u64,
        generation: u64,
        result: Result<Value, String>,
    ) -> Result<bool> {
        let effects = self.flows.resume(view, slot, epoch, generation, result);
        let dirty = crate::client_control::apply(self, view, effects);
        // 续步在同一轮内发出；通道满则留给下一轮 pump 保序重试。
        if let Some(staged) = self.flows.take_staged()
            && let Some(staged) = self.transmit(staged, view)?
        {
            self.flows.restore(staged);
        }
        Ok(dirty)
    }

    fn transmit(&mut self, staged: Staged, view: &View) -> Result<Option<Staged>> {
        // 世代已变：释放旧 flow 槽（按 epoch 确认身份），不让它永久占位。
        if staged.generation != view.generation {
            self.flows.drop_slot_if(staged.slot, staged.epoch);
            return Ok(None);
        }
        let token = self.allocate()?;
        self.operations.begin_flow(
            token,
            staged.slot,
            view.session.clone(),
            staged.generation,
            staged.epoch,
        );
        let request = ClientMsg::Request {
            token,
            method: staged.method,
            params: staged.params.clone(),
        };
        match self.to.try_send(request) {
            Ok(()) => {
                self.flows.mark_sent(staged.slot, token);
                Ok(None)
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.operations.cancel(token);
                Ok(Some(staged))
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.operations.cancel(token);
                bail!("Runtime stopped")
            }
        }
    }

    /// 主循环每轮有界取走已完成票据，不做阻塞等待。
    pub fn take_operation_replies(&mut self) -> Vec<OpReply> {
        self.operations.take()
    }

    /// 主循环每轮有界地取走已完成的只读结果，不做阻塞等待。
    pub fn take_read_replies(&mut self) -> Vec<ReadReply> {
        self.reads.take()
    }

    /// 测试专用：把一条已完成回包放入唯一完成队列（不新增发送路径）。
    #[cfg(test)]
    pub(crate) fn test_push_completed(&mut self, reply: OpReply) {
        self.operations.push_completed_for_test(reply);
    }

    /// 未知 token 的保留窗口大小；仅测试断言“不会无限堆”。
    #[cfg(test)]
    pub(crate) fn pending_orphan_replies(&self) -> usize {
        self.replies.len()
    }

    /// Reply 的唯一分流点：票据回包进完成队列，其余按有界窗口保留。
    pub(crate) fn reply(&mut self, token: u64, result: Result<Value, RuntimeError>) {
        if self.operations.complete(token, result.clone()) {
            return;
        }
        if self.reads.complete(token, result.clone()) {
            return;
        }
        if self.replies.insert(token, result).is_none() {
            self.reply_order.push_back(token);
        }
        while self.reply_order.len() > MAX_UNKNOWN_REPLIES {
            if let Some(oldest) = self.reply_order.pop_front() {
                self.replies.remove(&oldest);
            }
        }
    }
}
