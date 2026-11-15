//! Node `CronPauseSelf` 的执行边界与生产适配器（3.18 F14）。
//!
//! 顺序与 Node handler 一致：先判定本轮 Host 准入的 automationId，再校验空输入，
//! 最后要求端口可用。执行只经 `AutomationPort`，由 Engine 的 `Event::HostRequest`
//! 走既有 Host 通道（Host 侧是既有的 automationOwner 校验），不开第二 runtime/队列。
use crate::contract::{AutomationPort, Event, EventSink, InputValidationError, ToolOutput};
use crate::domain::automation;
use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// 生产适配器：本轮 automationId + 本 run 的事件通道。
pub(super) struct EngineAutomation<'a> {
    id: Option<&'a str>,
    events: &'a EventSink,
}

impl<'a> EngineAutomation<'a> {
    pub(super) fn new(id: Option<&'a str>, events: &'a EventSink) -> Self {
        Self {
            id: automation::admitted_id(id),
            events,
        }
    }
}

#[async_trait]
impl AutomationPort for EngineAutomation<'_> {
    fn self_id(&self) -> Option<&str> {
        self.id
    }

    async fn pause_self(&self, cancel: &CancellationToken) -> Result<bool> {
        let id = self
            .id
            .ok_or_else(|| anyhow!(automation::ERROR_NO_AUTOMATION))?;
        let (reply, receipt) = oneshot::channel();
        self.events
            .send(Event::HostRequest {
                method: "automation/pause",
                // Host schema 是 strict：只传被准入的 id，不夹带 requestId/workspace。
                params: json!({"automationId": id}),
                reply,
            })
            .await?;
        let answer = tokio::select! {biased;
            _=cancel.cancelled()=>bail!(automation::ERROR_CANCELLED),
            answer=receipt=>answer.map_err(|_| anyhow!(automation::ERROR_CANCELLED))?,
        };
        automation::parse_pause(&answer).map_err(|error| anyhow!(error))
    }
}

/// 一次工具调用：身份门 → 输入门 → 端口门 → Host 结论。
pub(super) async fn execute(
    args: &Value,
    automation_id: Option<&str>,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<ToolOutput> {
    let port = EngineAutomation::new(automation_id, sink);
    let id = port
        .self_id()
        .ok_or_else(|| anyhow!(automation::ERROR_NO_AUTOMATION))?;
    automation::validate_input(args)
        .map_err(|message| anyhow::Error::new(InputValidationError::new(message)))?;
    let paused = port.pause_self(cancel).await?;
    let (content, data) = automation::pause_result(id, paused);
    Ok(ToolOutput::new(content, data))
}
