use crate::{
    client::Client,
    projection::View,
    transport::{Request, Resume},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use zcode_cli_core_api::{ClientMsg, Method};

pub(crate) fn command(session: &str, kind: &str, payload: Value) -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    json!({"commandId":uuid::Uuid::new_v4().to_string(),"clientId":"zcode-cli-tui","sessionId":session,"type":kind,"payload":payload,"issuedAt":now})
}
pub(crate) fn accepted(ack: Value) -> Result<()> {
    if ack["status"] != "accepted" {
        bail!(
            "{}",
            ack["message"]
                .as_str()
                .or(ack["reasonCode"].as_str())
                .unwrap_or("Command was not accepted")
        );
    }
    Ok(())
}
pub(crate) async fn open(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    target: Resume,
) -> Result<()> {
    let id = match target {
        Resume::New => None,
        Resume::Id(id) => Some(id),
        Resume::Latest => {
            let listed = client
                .call(
                    view,
                    Method::SessionList,
                    json!({"workspace":request.workspace}),
                )
                .await?;
            Some(
                listed["sessions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|s| s.get("parentSessionId").is_none_or(Value::is_null))
                    .max_by_key(|s| s["updatedAt"].as_u64().unwrap_or(0))
                    .and_then(|s| s["sessionId"].as_str())
                    .context("No resumable session found")?
                    .to_owned(),
            )
        }
    };
    let is_resuming = id.is_some();
    let mode = if view.state["config"].is_object() {
        view.mode().to_owned()
    } else {
        request
            .mode_override
            .clone()
            .unwrap_or_else(|| "build".into())
    };
    let data =
        match id.as_ref() {
            Some(id) => {
                client
                    .call(
                        view,
                        Method::SessionResume,
                        json!({"sessionId":id,"workspace":request.workspace}),
                    )
                    .await?
            }
            None => client
                .call(
                    view,
                    Method::SessionCreate,
                    json!({"workspace":request.workspace,"mode":mode,"persistence":"immediate"}),
                )
                .await?,
        };
    let id = data["session"]["sessionId"]
        .as_str()
        .or(id.as_deref())
        .context("Missing session id")?
        .to_owned();
    // session/resume restores its persisted mode. Only an explicit CLI --mode
    // may override that state; defaults must not rewrite existing sessions.
    if is_resuming && let Some(mode) = request.mode_override.as_deref() {
        client
            .call(
                view,
                Method::SessionSetMode,
                json!({"sessionId":id,"mode":mode}),
            )
            .await?;
    }
    let topic = format!("conversation/{id}");
    let snapshot = client
        .call(
            view,
            Method::TopicOpen,
            json!({"topic":topic,"forceSnapshot":true}),
        )
        .await?;
    let previous = std::mem::take(&mut view.session);
    view.snapshot(&snapshot["snapshot"]);
    view.models = data["settings"]["model"]["available"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    view.notices.clear();
    // 恢复当前会话时不能释放同一个刚打开的 topic，否则下一轮流式事件会被取消订阅。
    if !previous.is_empty() && previous != view.session {
        client
            .to
            .send(ClientMsg::TopicReleased {
                topic: format!("conversation/{previous}"),
            })
            .await?;
    }
    Ok(())
}
pub(crate) async fn submit(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<()> {
    let mut payload = json!({"text":text});
    // 附件只来自未提交草稿：已删除的 inline 占位符不发送，pinned 项由 DraftAttachments 管。
    // busy 时显式请求 actor 的 FIFO queue，而不是在本地另存一份 accepted queue。
    if !view.draft_attachments.is_empty() {
        let attachments = view.draft_attachments.refs_for_text(text);
        if !attachments.is_empty() {
            payload["attachments"] = json!(attachments);
        }
    }
    if view.busy() {
        payload["requestedDelivery"] = "queue".into();
    }
    let tools: Vec<_> = request
        .disallowed_tools
        .iter()
        .map(|s| s.split('(').next().unwrap_or(s).trim())
        .filter(|s| !s.is_empty())
        .collect();
    if !tools.is_empty() {
        payload["toolDisallowlist"] = json!(tools);
    }
    view.pending_submit = true;
    let result = client
        .call(
            view,
            Method::Command,
            command(&view.session, "sendText", payload),
        )
        .await;
    let ack = match result {
        Ok(ack) => ack,
        Err(error) => {
            view.pending_submit = false;
            return Err(error);
        }
    };
    if ack["status"] == "accepted" {
        return Ok(());
    }
    view.pending_submit = false;
    // paused 队列仍有旧项时 actor 要求显式 heldQueueDisposition；TUI 不代替用户
    // 清空/覆盖旧项，也不自动补 keepQueueAndSend，只保留草稿并给双语出路。
    if ack["reasonCode"].as_str() == Some("heldQueueDispositionRequired") {
        bail!(
            "{}",
            view.text(
                "The queue is paused with queued input, so the draft was not submitted (heldQueueDispositionRequired). Use /queue resume to continue it, or /queue list to inspect and clean it.",
                "队列已暂停且仍有排队输入，草稿未提交（heldQueueDispositionRequired）。请使用 /queue resume 恢复队列，或用 /queue list 查看并清理旧项。"
            )
        );
    }
    accepted(ack)
}
pub(crate) async fn stop(client: &mut Client<'_>, view: &mut View) -> Result<()> {
    // 只带当前已知的前台执行 id；真实快照在 state.control.activeWorks 数组里，
    // 不是根级 activeWorks 对象。没有真实 id 时不伪造，保留原 stale-run 防护。
    let execution = view.state["control"]["activeWorks"]
        .as_array()
        .and_then(|works| {
            works.iter().find_map(|work| {
                work["foregroundExecutionId"]
                    .as_str()
                    .filter(|value| !value.is_empty())
            })
        });
    let mut payload = json!({});
    if let Some(execution) = execution {
        payload["expectedForegroundExecutionId"] = execution.into();
    }
    let ack = client
        .call(
            view,
            Method::Command,
            command(&view.session, "stop", payload),
        )
        .await?;
    // An already completed turn may legitimately make stop a noop.
    if ack["status"] == "noop" {
        return Ok(());
    }
    accepted(ack)
}

pub(crate) async fn set_setting(
    client: &mut Client<'_>,
    view: &mut View,
    method: Method,
    params: Value,
) -> Result<()> {
    client.call(view, method, params).await?;
    // 旧 setter 只广播 HostNotification，终端不消费 Host 的业务投影；从 actor 回拉快照，
    // 保证菜单与带参命令共用一条写入路径且展示已提交事实，而不是手改 UI config。
    client.refresh(view).await
}

/// Slash operations are requests to the actor, not mutations of a second session store.
/// 目录/帮助/压缩/档位由 `command_dispatch` 执行；此处保留原调用界面给 transport 与测试。
pub(crate) async fn slash(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<bool> {
    crate::command_dispatch::dispatch(client, view, request, text).await
}
