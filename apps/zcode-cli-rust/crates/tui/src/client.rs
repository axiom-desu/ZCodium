use crate::client_reads::ReadTickets;
pub(crate) use crate::client_reads::{QueryKind, ReadReply};
use crate::projection::View;
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, Method, RuntimeError, RuntimeEvent, ServerMsg};

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
    reads: ReadTickets,
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
    pub async fn call(&mut self, view: &mut View, method: Method, params: Value) -> Result<Value> {
        self.token = self
            .token
            .checked_add(1)
            .context("Request token exhausted")?;
        let expected = self.token;
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
        self.reads.forget_stale(view.generation);
        if self.reads.busy(kind) {
            return Ok(false);
        }
        self.token = self
            .token
            .checked_add(1)
            .context("Request token exhausted")?;
        let token = self.token;
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

    /// 主循环每轮有界地取走已完成的只读结果，不做阻塞等待。
    pub fn take_read_replies(&mut self) -> Vec<ReadReply> {
        self.reads.take()
    }

    /// 未知 token 的保留窗口大小；仅测试断言“不会无限堆”。
    #[cfg(test)]
    pub(crate) fn pending_orphan_replies(&self) -> usize {
        self.replies.len()
    }

    /// Reply 的唯一分流点：票据回包进完成队列，其余按有界窗口保留。
    fn reply(&mut self, token: u64, result: Result<Value, RuntimeError>) {
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
    pub async fn observe(&mut self, view: &mut View, message: ServerMsg) -> Result<()> {
        match message {
            ServerMsg::Event(RuntimeEvent::ConversationDeltas {
                session,
                from,
                to,
                deltas,
                ..
            }) => view.deltas(
                &session,
                from,
                to,
                deltas.iter().map(|(value, _)| value.clone()),
            ),
            ServerMsg::Event(RuntimeEvent::ConversationReset {
                session, snapshot, ..
            }) if session == view.session => view.snapshot(&snapshot),
            ServerMsg::Event(RuntimeEvent::TopicClosed { topic })
                if topic == format!("conversation/{}", view.session) =>
            {
                view.push(view.text("Session closed. Use /new.", "会话已关闭，请使用 /new。"));
                view.pending_submit = false;
                // closure 是 owner 的显式事件事实；不从 generation/epoch 差异推断。
                view.topic_closed = true;
                // TopicClosed 本身就是 owner 的终态事实；不能保留旧 canStop/审批阻塞 /new。
                view.state["control"]["canStop"] = false.into();
                view.state["pendingInteractions"] = serde_json::json!([]);
                view.resync = false;
                // 关闭即结束当前读票据的归属：旧 reply 不能写进下一次同 id 会话。
                view.generation = view.generation.wrapping_add(1);
                view.telemetry.reset();
            }
            ServerMsg::HostRequest { id, .. } => {
                self.to
                    .send(ClientMsg::HostReply {
                        id,
                        result: Value::Null,
                    })
                    .await?;
                view.push(view.text(
                    "Host-only request unavailable in terminal.",
                    "终端不支持该 Host 专用请求。",
                ));
            }
            ServerMsg::Reply { token, result } => self.reply(token, result),
            _ => {}
        }
        Ok(())
    }
    pub async fn refresh(&mut self, view: &mut View) -> Result<()> {
        let value = self.call(view, Method::TopicSnapshot, serde_json::json!({"topic":format!("conversation/{}",view.session),"forceSnapshot":true})).await?;
        view.snapshot(&value["snapshot"]);
        Ok(())
    }
}
