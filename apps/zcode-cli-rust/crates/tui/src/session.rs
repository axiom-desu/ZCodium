use crate::{
    client::Client,
    flow::Flow,
    flow_boot::Boot,
    flow_command::CommandFlow,
    flow_session_list::SessionList,
    flow_setting::Setting,
    interactions,
    operations::{OpKind, SentDraft},
    projection::View,
    transport::{Request, Resume},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

pub(crate) fn command(session: &str, kind: &str, payload: Value) -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    json!({"commandId":uuid::Uuid::new_v4().to_string(),"clientId":"zcode-cli-tui","sessionId":session,"type":kind,"payload":payload,"issuedAt":now})
}
pub(crate) async fn open(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    target: Resume,
) -> Result<()> {
    begin_open(client, view, request, target)?;
    // 只有测试驱动同一状态机到完成；生产路径只登记 workflow 就返回主循环。
    #[cfg(test)]
    crate::frontend_test_support::drive(client, view).await;
    Ok(())
}

/// 打开会话的唯一生产入口：只登记 boot workflow，不等任何 ACK。
pub(crate) fn begin_open(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    target: Resume,
) -> Result<()> {
    if !client.begin_flow(view, Flow::Boot(Boot::new(view, request, target)))? {
        bail!(
            "{}",
            view.text(
                "Another operation is still in flight; the session was not changed.",
                "已有操作在等待回包；会话未切换。"
            )
        );
    }
    Ok(())
}

/// `/sessions` 列表：只读 workflow，不等回包。
pub(crate) fn begin_list(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
) -> Result<()> {
    if !client.begin_flow(
        view,
        Flow::SessionList(SessionList::new(&request.workspace)),
    )? {
        bail!(
            "{}",
            view.text(
                "A session list request is already in flight.",
                "已有会话列表请求在等待回包。"
            )
        );
    }
    Ok(())
}
/// 非阻塞发出唯一 mutation；通道满或运行时消失时撤销槽并交还草稿。
///
/// 回包由 `Frontend::poll` 按 token/session/generation/epoch 结算，这里绝不等待 ACK。
fn dispatch(client: &mut Client<'_>, view: &mut View, kind: OpKind, params: Value) -> Result<()> {
    match client.dispatch_operation(
        &view.session,
        view.generation,
        &mut view.operations,
        kind,
        Method::Command,
        params,
    ) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            view.pending_submit = false;
            bail!(
                "{}",
                view.text(
                    "The runtime is busy; the draft was kept and was not sent. Press Enter again.",
                    "运行时当前繁忙；草稿已保留，未发送。请稍后再次按 Enter。"
                )
            )
        }
        Err(error) => {
            view.pending_submit = false;
            Err(error)
        }
    }
}

/// 普通正文提交：命令 UUID 只生成一次，发送后立即返回主循环。
pub(crate) async fn submit(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<()> {
    // Enter 入口已在 View 草稿上完成转移；直接调用本函数的测试仍从草稿取一份唯一副本。
    if view.operations.inflight_kind() != Some(OpKind::Submit) {
        // 先判忙/拒绝草稿，避免 begin 失败时把 View 唯一附件副本已经 take 走。
        if view.operations.busy() {
            bail!(
                "{}",
                view.text("An operation is still in flight.", "已有操作在等待回包。")
            );
        }
        // boot/setting/queue/picker 的 mutation workflow 在飞时不能再 admission。
        if client.mutation_flow_busy() {
            bail!(
                "{}",
                view.text(
                    "The session is still starting or another operation is in flight; the draft was kept.",
                    "会话仍在打开或已有操作在等待回包；草稿已保留。"
                )
            );
        }
        if view.operations.has_rejected() {
            bail!(
                "{}",
                view.text("A rejected draft is waiting.", "还有被拒绝的草稿未处理。")
            );
        }
        let attachments = std::mem::take(&mut view.draft_attachments);
        if let Err(error) = view.operations.begin(
            OpKind::Submit,
            &view.session,
            view.generation,
            Some(SentDraft::new(text, attachments)),
        ) {
            return Err(anyhow::anyhow!("{error:?}"));
        }
    }
    let mut payload = json!({"text":text});
    // 附件只有一份：已发送草稿由唯一在飞 operation 持有，未发送时读 View 草稿。
    // 等待 ACK 期间新输入的附件不会被这份 payload 或旧 ACK 影响。
    let attachments = view
        .operations
        .inflight_refs(text)
        .unwrap_or_else(|| view.draft_attachments.refs_for_text(text));
    if !attachments.is_empty() {
        payload["attachments"] = json!(attachments);
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
    let command = command(&view.session, "sendText", payload);
    if let Err(error) = dispatch(client, view, OpKind::Submit, command) {
        if let Some(draft) = view.operations.abort() {
            view.editor.replace_all(&draft.text);
            view.draft_attachments = draft.attachments;
        }
        return Err(error);
    }
    Ok(())
}

/// 交互回答走与 submit 相同的票据；回答文本不是普通正文，但拒绝时同样可整份恢复。
pub(crate) async fn resolve_interaction(
    client: &mut Client<'_>,
    view: &mut View,
    text: &str,
) -> Result<()> {
    let interaction = view
        .interaction()
        .cloned()
        .context("No pending interaction")?;
    let answer = interactions::answer(&interaction, text)?;
    if view.operations.inflight_kind() != Some(OpKind::Interaction) {
        if view.operations.busy() {
            bail!(
                "{}",
                view.text("An operation is still in flight.", "已有操作在等待回包。")
            );
        }
        if client.mutation_flow_busy() {
            bail!(
                "{}",
                view.text(
                    "Another operation is still waiting for the actor; the answer was kept.",
                    "已有操作在等待 actor 回包；回答已保留。"
                )
            );
        }
        if view.operations.has_rejected() {
            bail!(
                "{}",
                view.text("A rejected draft is waiting.", "还有被拒绝的草稿未处理。")
            );
        }
        let attachments = std::mem::take(&mut view.draft_attachments);
        view.operations
            .begin(
                OpKind::Interaction,
                &view.session,
                view.generation,
                Some(SentDraft::new(text, attachments)),
            )
            .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    }
    let params = command(
        &view.session,
        "resolveInteraction",
        json!({"interactionId":interaction["interactionId"],"answer":answer}),
    );
    if let Err(error) = dispatch(client, view, OpKind::Interaction, params) {
        if let Some(draft) = view.operations.abort() {
            view.editor.replace_all(&draft.text);
            view.draft_attachments = draft.attachments;
        }
        return Err(error);
    }
    Ok(())
}

/// Ctrl-C 的唯一 stop 意图；真实生效等 actor admission，不在这里等待 ACK。
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
    if view.operations.inflight_kind() != Some(OpKind::Stop) {
        view.operations
            .begin(OpKind::Stop, &view.session, view.generation, None)
            .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    }
    let params = command(&view.session, "stop", payload);
    if let Err(error) = dispatch(client, view, OpKind::Stop, params) {
        view.operations.abort();
        return Err(error);
    }
    Ok(())
}

pub(crate) async fn set_setting(
    client: &mut Client<'_>,
    view: &mut View,
    method: Method,
    params: Value,
) -> Result<()> {
    begin_setting(client, view, method, params)?;
    #[cfg(test)]
    crate::frontend_test_support::drive(client, view).await;
    Ok(())
}

/// setter 的唯一生产入口：只登记 setting workflow（setter → 同一 workflow 续步快照）。
pub(crate) fn begin_setting(
    client: &mut Client<'_>,
    view: &mut View,
    method: Method,
    params: Value,
) -> Result<()> {
    // 旧 setter 只广播 HostNotification，终端不消费 Host 的业务投影；快照由续步回拉，
    // 保证菜单与带参命令共用一条写入路径且展示已提交事实，而不是手改 UI config。
    // 菜单确认发起的 setter 成功后由同一 workflow 关闭这一份菜单（slash 路径没有菜单）。
    let close = view
        .selector
        .as_ref()
        .map(|selector| (selector.owner.clone(), view.generation));
    if !client.begin_flow(view, Flow::Setting(Setting::new(method, params, close)))? {
        bail!(
            "{}",
            view.text(
                "Another operation is still in flight; the setting was not changed.",
                "已有操作在等待回包；设置未修改。"
            )
        );
    }
    Ok(())
}

/// `/compact` 的唯一实现：canonical `/compact [instructions]` 的 sendText admission。
///
/// `restore` 是用户原始斜杠输入，被拒绝且主 editor 仍为空时整份交还。
pub(crate) async fn compact(
    client: &mut Client<'_>,
    view: &mut View,
    restore: &str,
    instructions: &str,
) -> Result<()> {
    // core 归一化按 `trimmed == "/compact" || trimmed.starts_with("/compact ")` 识别，
    // 所以无指令时不能带尾随空格；有指令时保留其内部换行与空格。
    let text = if instructions.is_empty() {
        "/compact".to_owned()
    } else {
        format!("/compact {instructions}")
    };
    let command = command(&view.session, "sendText", json!({"text": text}));
    if !client.begin_flow(
        view,
        Flow::Command(CommandFlow::new(command, restore.to_owned())),
    )? {
        bail!(
            "{}",
            view.text(
                "Another operation is still in flight; the draft was kept.",
                "已有操作在等待回包；草稿已保留。"
            )
        );
    }
    #[cfg(test)]
    crate::frontend_test_support::drive(client, view).await;
    Ok(())
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
