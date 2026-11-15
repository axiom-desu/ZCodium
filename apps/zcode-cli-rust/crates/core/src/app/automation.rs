//! 3.18：Host 权威请求的 Engine 侧出口（`automation/pause` 等 strict-params 方法）。
//!
//! 身份与队列边界：requestId 由 Engine 分配并只登记在 `waiters`，不写入 `params`
//! （Host schema 是 strict，额外字段会被 -32602 拒绝）；waiter 的 owner 是本轮会话，
//! 所以 stop/close 的 `release_waiters` 会撤销等待，工具不会读到假结论。
use super::Engine;
use crate::contract::{Event, RunEvent, ServerMsg};
use serde_json::{Value, json};
use tokio::sync::oneshot;

impl Engine {
    /// 执行期的 Host 请求：工具侧只给出方法、严格参数与回执通道。
    pub(super) fn host_request(
        &mut self,
        owner: &str,
        method: &'static str,
        params: Value,
        reply: oneshot::Sender<Value>,
    ) {
        if reply.is_closed() {
            return;
        }
        let request_id = format!("rust-host-{}", self.clock.id());
        let workspace = json!({
            "workspaceKey": self.workspace,
            "workspacePath": self.workspace_path,
            "workspaceIdentity": self.workspace,
        });
        self.waiters.add_host(
            request_id.clone(),
            super::waiters::HostWait {
                owner: owner.into(),
                workspace,
                // automation/pause 没有生命周期取消通知：Host 只按回执收口。
                announce: None,
                reply,
            },
        );
        self.outbox.push(ServerMsg::HostRequest {
            id: request_id,
            method,
            params,
        });
    }

    /// `Event::HostRequest` 的本轮处理；其他事件原样返回。
    pub(super) fn automation_side(&mut self, event: RunEvent) -> Option<RunEvent> {
        let RunEvent {
            session_id,
            run_id,
            event,
        } = event;
        let Event::HostRequest {
            method,
            params,
            reply,
        } = event
        else {
            return Some(RunEvent {
                session_id,
                run_id,
                event,
            });
        };
        self.host_request(&session_id, method, params, reply);
        None
    }
}
