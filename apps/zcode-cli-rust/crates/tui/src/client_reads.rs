//! 只读查询票据（spec cli-rust-tui-workbench §3「请求票据」）。
//!
//! MCP status、session usage、input history 共用唯一的 Client token 分配器；
//! 每张票据绑定发起时的 session + View.generation，完成结果同样带上原值，
//! 由主循环在应用前再次验证。tickets 与完成队列都由 Client 独占。
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use zcode_cli_core_api::RuntimeError;

/// 完成但尚未被主循环消费的结果上限；超出丢最旧，不因前端卡顿无限增长。
const MAX_COMPLETED: usize = 12;

/// 三类只读查询。History 的 skip 不参与限流分类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueryKind {
    McpStatus,
    Usage,
    History { skip: u32 },
}

/// 限流单位：同一 class 最多一笔在飞或未消费完成结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadClass {
    McpStatus,
    Usage,
    History,
}

impl QueryKind {
    fn class(self) -> ReadClass {
        match self {
            Self::McpStatus => ReadClass::McpStatus,
            Self::Usage => ReadClass::Usage,
            // 不同 skip 是同一路历史翻页，合并成一类，避免用 skip 绕开限流。
            Self::History { .. } => ReadClass::History,
        }
    }
}

/// 一次只读查询的完成结果；session/generation 保留发起时的原值。
pub(crate) struct ReadReply {
    pub kind: QueryKind,
    pub session: String,
    pub generation: u64,
    pub result: Result<Value, RuntimeError>,
}

struct Ticket {
    kind: QueryKind,
    session: String,
    generation: u64,
}

#[derive(Default)]
pub(crate) struct ReadTickets {
    in_flight: HashMap<u64, Ticket>,
    completed: VecDeque<ReadReply>,
}

impl ReadTickets {
    pub(crate) fn begin(&mut self, token: u64, kind: QueryKind, session: String, generation: u64) {
        self.in_flight.insert(
            token,
            Ticket {
                kind,
                session,
                generation,
            },
        );
    }

    /// 发送失败时撤销票据，避免占用 class slot。
    pub(crate) fn cancel(&mut self, token: u64) {
        self.in_flight.remove(&token);
    }

    pub(crate) fn busy(&self, kind: QueryKind) -> bool {
        let class = kind.class();
        self.in_flight.values().any(|t| t.kind.class() == class)
            || self.completed.iter().any(|r| r.kind.class() == class)
    }

    /// 把回包转成完成结果；未知/过期 token 返回 false，由调用方按有界窗口处理。
    pub(crate) fn complete(&mut self, token: u64, result: Result<Value, RuntimeError>) -> bool {
        let Some(ticket) = self.in_flight.remove(&token) else {
            return false;
        };
        self.completed.push_back(ReadReply {
            kind: ticket.kind,
            session: ticket.session,
            generation: ticket.generation,
            result,
        });
        while self.completed.len() > MAX_COMPLETED {
            self.completed.pop_front();
        }
        true
    }

    /// 切 session / TopicClosed 后旧票据永不回包也不能永久占位：只保留当前 generation。
    pub(crate) fn forget_stale(&mut self, generation: u64) {
        self.in_flight
            .retain(|_, ticket| ticket.generation == generation);
        self.completed
            .retain(|reply| reply.generation == generation);
    }

    pub(crate) fn take(&mut self) -> Vec<ReadReply> {
        self.completed.drain(..).collect()
    }
}
