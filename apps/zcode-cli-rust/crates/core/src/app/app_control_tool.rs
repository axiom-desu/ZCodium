//! 3.18 App 会话控制十二工具的执行边界与生产适配器（Rust native）。
//!
//! 顺序与 TS handler 一致：本轮授予门（Host 能力 + mainRoot + 非子代理）→ 工具输入门
//! （`retryOf` → 可信 `requestId`）→ 端口门（经既有 `Event::HostRequest`）→ Host 封闭回执。
//! 身份只来自本次 run：`callerSessionId` 是本轮会话，`callId` 是本次工具调用；
//! 模型输入只承载 `input`，无法提供连接、根会话、能力或请求身份。
//!
//! 队列边界：不新增 accepted/mutation 队列，写意图仍由 Host 的既有 owner 经原 CommandInbox 串行；
//! 本模块只登记既有 `waiters`（owner = 本轮会话），stop/close 的释放会让等待以取消收口。
use crate::contract::{Event, EventSink, InputValidationError, ToolOutput};
use crate::domain::app_control::{self, Intent};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// 生产适配器：本轮会话与本次调用的身份 + 本 run 的既有事件通道。
struct EngineAppControl<'a> {
    session: &'a str,
    call: &'a str,
    events: &'a EventSink,
}

impl EngineAppControl<'_> {
    async fn request(
        &self,
        intent: &Intent,
        input: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let (reply, receipt) = oneshot::channel();
        self.events
            .send(Event::HostRequest {
                method: intent.method,
                // Host schema 是 strict：只允许 callerSessionId/callId/[turnId]/input。
                // `turnId` 不透传（Rust 没有与 Node traceContext.turnId 对等的可信字段，
                // Host 的 schema 允许缺席），也不从模型输入里取。
                params: json!({
                    "callerSessionId": self.session,
                    "callId": self.call,
                    "input": input,
                }),
                reply,
            })
            .await?;
        let answer = tokio::select! {biased;
            // 等待期间 run 被取消：语义错误，不返回 Host 结果、不写成功。
            // 已释放的 waiter 不会再被迟到的回执唤醒（回执按请求 id 归属）。
            _ = cancel.cancelled() => bail!(app_control::ERROR_CANCELLED),
            answer = receipt => answer.map_err(|_| anyhow!(app_control::ERROR_CANCELLED))?,
        };
        Ok(answer)
    }
}

/// 一次工具调用：授予门 → 输入门 → 端口门 → Host 结论。
pub(super) async fn execute(
    name: &str,
    args: &Value,
    call: &str,
    granted: bool,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<ToolOutput> {
    let Some(intent) = app_control::intent(name) else {
        bail!("Tool not found: {name}");
    };
    // 能力与根会话结论只读本轮授予：不注册时的强行调用在这里失败，且不发 Host 请求。
    if !granted {
        bail!(app_control::ERROR_UNAVAILABLE);
    }
    let input = app_control::prepare_input(intent, args, call)
        .map_err(|message| anyhow::Error::new(InputValidationError::new(message)))?;
    let adapter = EngineAppControl {
        session: &sink.session_id,
        call,
        events: sink,
    };
    let answer = adapter.request(intent, input, cancel).await?;
    let result = app_control::parse_reply(intent, &answer).map_err(|message| anyhow!(message))?;
    // Node `serializeOutput`：处理器返回结构化结果时，模型看到的是它的 JSON 文本。
    let content = crate::domain::js_json::stringify(&result);
    Ok(ToolOutput::new(content, result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{RequestOrigin, RunEvent};

    fn sink(run_id: &str) -> (EventSink, tokio::sync::mpsc::Receiver<RunEvent>) {
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        (
            EventSink {
                session_id: "s1".into(),
                run_id: run_id.into(),
                tx,
                origin: std::sync::Arc::new(RequestOrigin::default()),
                request_auth: None,
            },
            rx,
        )
    }

    #[tokio::test]
    async fn an_ungranted_call_fails_before_any_host_request() {
        let (sink, mut events) = sink("r1");
        let cancel = CancellationToken::new();
        let error = match execute("ListProjects", &json!({}), "call-1", false, &sink, &cancel).await
        {
            Err(error) => error,
            Ok(output) => panic!("unexpected output: {}", output.content),
        };
        assert_eq!(error.to_string(), app_control::ERROR_UNAVAILABLE);
        assert!(events.try_recv().is_err(), "no host request");
    }

    #[tokio::test]
    async fn the_request_carries_only_the_trusted_identity_and_the_model_input() {
        let (sink, mut events) = sink("r1");
        let cancel = CancellationToken::new();
        let pending = tokio::spawn({
            let sink = sink.clone();
            async move {
                execute(
                    "SendToSession",
                    &json!({"sessionId":"s2","prompt":"hi","retryOf":"req-7"}),
                    "call-9",
                    true,
                    &sink,
                    &CancellationToken::new(),
                )
                .await
            }
        });
        let RunEvent { event, .. } = events.recv().await.unwrap();
        let Event::HostRequest {
            method,
            params,
            reply,
        } = event
        else {
            panic!("not a host request");
        };
        assert_eq!(method, "appControl/sendToSession");
        assert_eq!(
            params,
            serde_json::json!({
                "callerSessionId": "s1",
                "callId": "call-9",
                "input": {"sessionId":"s2","prompt":"hi","requestId":"req-7"},
            })
        );
        reply
            .send(serde_json::json!({"ok":true,"result":{"status":"accepted"}}))
            .unwrap();
        let output = pending.await.unwrap().unwrap();
        assert_eq!(output.data, serde_json::json!({"status":"accepted"}));
        assert!(!cancel.is_cancelled());
    }
}
