use crate::projection::View;
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, Method, RuntimeError, RuntimeEvent, ServerMsg};

pub(crate) struct Client<'a> {
    pub to: &'a mpsc::Sender<ClientMsg>,
    from: &'a mut mpsc::Receiver<Vec<ServerMsg>>,
    pending: VecDeque<ServerMsg>,
    replies: HashMap<u64, Result<Value, RuntimeError>>,
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
                self.replies.insert(token, result);
            } else {
                self.observe(view, message).await?;
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
                // TopicClosed 本身就是 owner 的终态事实；不能保留旧 canStop/审批阻塞 /new。
                view.state["control"]["canStop"] = false.into();
                view.state["pendingInteractions"] = serde_json::json!([]);
                view.resync = false;
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
            ServerMsg::Reply { token, result } => {
                self.replies.insert(token, result);
            }
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
