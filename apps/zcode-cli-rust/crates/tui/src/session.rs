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
    if !request.attachments.is_empty() {
        payload["attachments"] = json!(request.attachments);
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
    match result.and_then(accepted) {
        Ok(()) => Ok(()),
        Err(error) => {
            view.pending_submit = false;
            Err(error)
        }
    }
}
pub(crate) async fn stop(client: &mut Client<'_>, view: &mut View) -> Result<()> {
    let ack = client
        .call(
            view,
            Method::Command,
            command(&view.session, "stop", json!({})),
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
pub(crate) async fn slash(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<bool> {
    let words: Vec<_> = text.split_whitespace().collect();
    match words.as_slice() {
        ["/quit" | "/exit"] => return Ok(true),
        ["/help"] => view.push(view.text("/help /new /sessions /resume <id> /mode <mode> /model [provider model [reasoning]] /quit", "/help 帮助 · /new 新会话 · /sessions 列表 · /resume <id> 恢复 · /mode <模式> · /model [provider model [reasoning]] · /quit 退出")),
        ["/new"] => open(client,view,request,Resume::New).await?,
        ["/resume",id] => open(client,view,request,Resume::Id((*id).into())).await?,
        ["/sessions"] => {
            let data=client.call(view,Method::SessionList,json!({"workspace":request.workspace})).await?;
            for session in data["sessions"].as_array().into_iter().flatten() {
                view.push(&format!("{} {}",session["sessionId"].as_str().unwrap_or("?"),session["title"].as_str().unwrap_or("")));
            }
        }
        ["/mode",mode] => { set_setting(client,view,Method::SessionSetMode,json!({"sessionId":view.session,"mode":mode})).await?; }
        ["/model"] => {
            for model in view.models.clone() { view.push(&format!("{} {}",model["ref"]["providerId"].as_str().unwrap_or(""),model["ref"]["modelId"].as_str().unwrap_or(""))); }
            view.push(view.text("Use /model <providerId> <modelId> [reasoningLevel]", "使用 /model <providerId> <modelId> [reasoningLevel]"));
        }
        ["/model",provider,model] | ["/model",provider,model,_] => {
            let mut selection=json!({"providerId":provider,"modelId":model});
            let level=words.get(3).copied().or_else(||view.models.iter().find(|m|m["ref"]["providerId"]==*provider && m["ref"]["modelId"]==*model).and_then(|m|m["reasoning"]["defaultLevel"].as_str()));
            if let Some(level)=level { selection["options"]=json!({"reasoningLevel":level}); }
            set_setting(client,view,Method::SessionSetModel,json!({"sessionId":view.session,"model":selection})).await?;
        }
        _ => bail!("Unknown command. /help"),
    }
    Ok(false)
}
