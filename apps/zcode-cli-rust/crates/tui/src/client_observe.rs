//! 运行时事件到 View 的唯一观察入口：reset 走 owner 事件、普通回包走有界票据分流。
use crate::client::Client;
use crate::projection::View;
use anyhow::Result;
use zcode_cli_core_api::{RuntimeEvent, ServerMsg};

impl Client<'_> {
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
            }) if session == view.session => {
                // reset 是 owner 的显式新 epoch 事实，seq 可能回退；不能按迟到 delta 丢弃。
                view.reset_snapshot(&snapshot);
            }
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
                crate::client_control::host_request_unavailable(self, view, id);
            }
            ServerMsg::Reply { token, result } => self.reply(token, result),
            _ => {}
        }
        Ok(())
    }
}
