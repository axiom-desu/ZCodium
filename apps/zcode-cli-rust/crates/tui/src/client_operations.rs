//! UI mutation / workflow 的非阻塞票据（spec cli-rust-tui-responsive-operations §接口与模块边界）。
//!
//! Client 仍是唯一 token 分配器与回包分流点：本模块只保存“已发送未结算”的票据与
//! 完成队列，主循环每轮有界 drain，不 await 新 ACK，也不另起请求通道。
//!
//! 票据分两类，共用同一个分配器与同一个完成队列：
//! - [`TicketKind::Draft`]：`Operations` 独占 `SentDraft` 的正文/交互/停止 mutation；
//! - [`TicketKind::Flow`]：boot、setting、queue、picker、snapshot 的续步 workflow。
use crate::flow::Slot;
use crate::operations::OpKind;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use zcode_cli_core_api::RuntimeError;

/// 实际只有 Draft1 + FlowMutation1 + FlowRead1；完成结果必须逐槽结算，不能丢最旧。
const MAX_COMPLETED: usize = 3;

/// 一张票据的归属类型；回包按它分流到 draft 结算或 workflow 续步。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TicketKind {
    Draft(OpKind),
    Flow(Slot),
}

/// 一条已发送请求的完成结果；session/generation/epoch 保留发起时的原值。
pub(crate) struct OpReply {
    pub kind: TicketKind,
    pub session: String,
    pub generation: u64,
    pub epoch: u64,
    pub result: Result<Value, RuntimeError>,
}

struct OpTicket {
    kind: TicketKind,
    session: String,
    generation: u64,
    epoch: u64,
}

#[derive(Default)]
pub(crate) struct OpTickets {
    in_flight: HashMap<u64, OpTicket>,
    completed: VecDeque<OpReply>,
    /// 在飞的 draft 票据数：draft 侧一次只允许一条。
    drafts: usize,
}

impl OpTickets {
    pub(crate) fn begin_draft(
        &mut self,
        token: u64,
        kind: OpKind,
        session: String,
        generation: u64,
        epoch: u64,
    ) {
        self.drafts += 1;
        self.in_flight.insert(
            token,
            OpTicket {
                kind: TicketKind::Draft(kind),
                session,
                generation,
                epoch,
            },
        );
    }

    pub(crate) fn begin_flow(
        &mut self,
        token: u64,
        slot: Slot,
        session: String,
        generation: u64,
        epoch: u64,
    ) {
        self.in_flight.insert(
            token,
            OpTicket {
                kind: TicketKind::Flow(slot),
                session,
                generation,
                epoch,
            },
        );
    }

    pub(crate) fn cancel(&mut self, token: u64) {
        if let Some(ticket) = self.in_flight.remove(&token)
            && matches!(ticket.kind, TicketKind::Draft(_))
        {
            self.drafts = self.drafts.saturating_sub(1);
        }
    }

    /// draft mutation 是否还能立即发出：一次只允许一条在飞且没有未结算结果。
    pub(crate) fn draft_ready(&self) -> bool {
        self.drafts == 0
            && !self
                .completed
                .iter()
                .any(|reply| matches!(reply.kind, TicketKind::Draft(_)))
    }

    /// flow 槽在完成结果被 take 前不得重开；每个槽各占一条 receipt。
    pub(crate) fn flow_ready(&self, slot: Slot) -> bool {
        !self
            .completed
            .iter()
            .any(|reply| reply.kind == TicketKind::Flow(slot))
    }

    fn push_completed(&mut self, reply: OpReply) {
        // 构造不变量：三个槽最多三条未结算结果；超过是状态机 bug，显式失败而非丢 ACK。
        assert!(
            self.completed.len() < MAX_COMPLETED,
            "operation completion queue exceeded its slot bound"
        );
        self.completed.push_back(reply);
    }

    /// 切 session / TopicClosed 后旧票据永不回包：按 generation 释放槽位，避免永久占位。
    pub(crate) fn forget_stale(&mut self, generation: u64) {
        let mut released = 0usize;
        self.in_flight.retain(|_, ticket| {
            let keep = ticket.generation == generation;
            if !keep && matches!(ticket.kind, TicketKind::Draft(_)) {
                released += 1;
            }
            keep
        });
        self.drafts = self.drafts.saturating_sub(released);
        self.completed
            .retain(|reply| reply.generation == generation);
    }

    /// 把回包转成完成结果；未知/已过期 token 返回 false 交给有界窗口处理。
    pub(crate) fn complete(&mut self, token: u64, result: Result<Value, RuntimeError>) -> bool {
        let Some(ticket) = self.in_flight.remove(&token) else {
            return false;
        };
        if matches!(ticket.kind, TicketKind::Draft(_)) {
            self.drafts = self.drafts.saturating_sub(1);
        }
        self.push_completed(OpReply {
            kind: ticket.kind,
            session: ticket.session,
            generation: ticket.generation,
            epoch: ticket.epoch,
            result,
        });
        true
    }

    pub(crate) fn take(&mut self) -> Vec<OpReply> {
        self.completed.drain(..).collect()
    }

    /// 测试专用：把一条已完成回包放入唯一完成队列，驱动同一 settle 状态机。
    /// 不新增发送路径，也不改变生产分流。
    #[cfg(test)]
    pub(crate) fn push_completed_for_test(&mut self, reply: OpReply) {
        self.push_completed(reply);
    }
}
