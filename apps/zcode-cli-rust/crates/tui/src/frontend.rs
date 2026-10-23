//! 前端集成：Enter/Paste 分流、已完成结果的有界 poll，以及历史读写桥接。
//!
//! 这里不拥有会话事实：历史只从内部读票据取回，队列/审批/会话仍由 actor 提交后的
//! snapshot 驱动。MCP/usage/history 三类只读票据由 [`Frontend::poll`] 从 Client 完成队列
//! drain，不 await 这些读回包；继承的 gaprepair/`resync` 仍走 `Client::refresh` 的串行
//! `TopicSnapshot`，bootstrap 与会话 setter 也仍是串行 `call` + snapshot，故 poll 并非全路径非阻塞。
use crate::{
    client::{Client, QueryKind, ReadReply},
    commands,
    draft_attachments::DraftAttachments,
    editor::sanitize,
    input_history::{Applied, Draft, Step},
    interactions, picker,
    projection::View,
    queue, session, telemetry,
    transport::Request,
};
use anyhow::{Result, bail};
use serde_json::json;
use zcode_cli_core_api::Method;

/// 跨事件保留的前端小状态：重复错误提示去重与 Ctrl-X 前缀。
#[derive(Default)]
pub(crate) struct Frontend {
    mention_error: Option<String>,
    pub(crate) sidebar_leader: bool,
    /// 上一次收敛时的会话/世代：TopicClosed 也会推进 generation，旧编辑与游标必须失效。
    /// 这里只记录本地收敛基线，绝不据此推断 TopicClosed 事件。
    session: String,
    generation: u64,
}

impl Frontend {
    /// 启动时把 `--attach` 投影成第一份草稿的 pinned 附件；非法项整批报错。
    pub(crate) fn start(&mut self, view: &mut View, request: &Request) -> Result<()> {
        view.draft_attachments = DraftAttachments::from_startup(request.attachments.clone())?;
        if view.draft_attachments.startup_duplicates() > 0 {
            let kept = view.draft_attachments.items().len();
            let note = if view.zh {
                format!("重复的启动附件已忽略；保留 {kept} 个。")
            } else {
                format!("Duplicate startup attachments were ignored; {kept} kept.")
            };
            view.push(&note);
        }
        Ok(())
    }

    /// 主循环每个 tick / 事件后调用：drain MCP/usage/history 三类已完成只读结果，
    /// 不 await 这些读回包；但继承的 `resync` gaprepair 仍会 `client.refresh(view).await`
    /// 串行拉取并应用 `TopicSnapshot`，因此 poll 的该路径仍可能阻塞键盘/退出。
    pub(crate) async fn poll(&mut self, client: &mut Client<'_>, view: &mut View) -> Result<bool> {
        let mut dirty = false;
        if view.file_mentions.poll() {
            dirty = true;
            self.report_mention_error(view);
        }
        for reply in client.take_read_replies() {
            dirty |= match reply.kind {
                QueryKind::History { .. } => apply_history(view, reply),
                _ => {
                    telemetry::apply_reply(view, reply);
                    true
                }
            };
        }
        if view.resync {
            client.refresh(view).await?;
            dirty = true;
        }
        Ok(dirty)
    }

    /// 每个真实键/Paste/恢复之后收敛本地草稿：删掉的占位符不再发送，mention token 重新对齐。
    pub(crate) fn after_change(&mut self, view: &mut View) {
        if self.session != view.session || self.generation != view.generation {
            // 同 id resume 会经 mem::take + snapshot 推进 generation，但会话并未关闭。
            // topic_closed 只来自真实 TopicClosed 事件、只由成功 snapshot/open 解除，
            // 因此这里仅失效选择器/历史记忆，不从世代猜事件。
            self.session = view.session.clone();
            self.generation = view.generation;
            // 选择器/历史属于上一世代；队列编辑草稿保留为失效缓冲，由用户 Esc 取消。
            view.selector = None;
            view.history.reset(&view.session, view.generation);
        }
        view.draft_attachments.retain_for_text(view.editor.text());
        let enabled =
            view.selector.is_none() && view.interaction().is_none() && view.queue_edit.is_none();
        view.file_mentions
            .sync(&view.editor, &view.directory, view.generation, enabled);
        view.sync_completion();
    }

    fn report_mention_error(&mut self, view: &mut View) {
        let error = view.file_mentions.error().map(str::to_owned);
        if error == self.mention_error {
            return;
        }
        self.mention_error = error.clone();
        if let Some(error) = error {
            let prefix = view.text("File search failed:", "文件搜索失败：");
            view.push(&format!("{prefix} {error}"));
        }
    }
}

/// Enter 的唯一提交入口：先接受补全，再清空草稿走原 enter 分流；
/// 本地/远端拒绝都把同一份草稿放回编辑器，草稿附件保持不动。
pub(crate) async fn submit_editor(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
) -> Result<bool> {
    view.accept_completion();
    let text = view.editor.clear();
    match enter(client, view, request, &text).await {
        Ok(quit) => Ok(quit),
        Err(error) => {
            view.push(&format!("Error: {error}"));
            view.editor.replace_all(&text);
            Ok(false)
        }
    }
}

/// `/quit`、审批回答、slash 与普通正文的唯一分流点。
async fn enter(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<bool> {
    if matches!(text.trim(), "/quit" | "/exit") {
        if view.busy() {
            session::stop(client, view).await?;
        }
        return Ok(true);
    }
    if let Some(interaction) = view.interaction().cloned() {
        let answer = interactions::answer(&interaction, text)?;
        let params = session::command(
            &view.session,
            "resolveInteraction",
            json!({"interactionId":interaction["interactionId"],"answer":answer}),
        );
        session::accepted(client.call(view, Method::Command, params).await?)?;
        return Ok(false);
    }
    if text.starts_with('/') {
        return slash(client, view, request, text).await;
    }
    if !text.trim().is_empty() {
        // busy 时 session::submit 会显式带 requestedDelivery:"queue" 交给 actor FIFO。
        session::submit(client, view, request, text).await?;
        // 只有真正被接受（submit 已校验 ACK）才清草稿附件；失败路径由 submit_editor 保留正文。
        view.draft_attachments.clear();
        // 已接受的正文结束本轮历史浏览；失败时游标仍保留给用户重试。
        view.history.edited();
    }
    Ok(false)
}

/// slash 的前端分流：busy 只放行只读查询与 `/queue`，未知命令仍本地拒绝。
async fn slash(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<bool> {
    if view.busy() {
        if queue::handles(text) {
            return session::slash(client, view, request, text).await;
        }
        let trimmed = text.trim();
        if trimmed == "/mcp" {
            telemetry::request_mcp(client, view, request);
            return Ok(false);
        }
        if trimmed == "/usage" {
            telemetry::request_usage(client, view)?;
            return Ok(false);
        }
        let first = text.split_whitespace().next().unwrap_or("");
        if commands::find(first).is_some() {
            bail!(
                "{}",
                view.text(
                    "Turn is busy; draft was not submitted.",
                    "运行中；草稿尚未提交。"
                )
            );
        }
        // 未知 slash 仍由 dispatcher 本地拒绝，绝不作为正文发给模型。
        return session::slash(client, view, request, text).await;
    }
    if matches!(text.trim(), "/model" | "/mode" | "/sessions") {
        picker::open(client, view, request, text).await?;
        return Ok(false);
    }
    session::slash(client, view, request, text).await
}

/// Paste 的唯一入口：权限/问答优先给主 editor；否则进队列编辑 buffer，再到 selector/editor。
///
/// 只有真正写入主 editor（普通草稿或审批/问答回答）才算编辑历史草稿；队列编辑与
/// selector filter 各有自己的 buffer，不能误清 main history 的 pending/saved。
pub(crate) fn paste_into(view: &mut View, text: &str) {
    if view.interaction().is_some() {
        view.editor.insert(&sanitize(text));
        view.history.edited();
    } else if let Some(edit) = view.queue_edit.as_mut() {
        edit.editor.insert(&sanitize(text));
    } else if let Some(selector) = view.selector.as_mut() {
        selector.push_filter(text);
    } else {
        view.editor.insert(&sanitize(text));
        view.history.edited();
    }
}

/// ↑ 历史：发送失败/在飞都不阻塞；结果由 `poll` 在验证 session/generation 后应用。
pub(crate) async fn history_up(client: &mut Client<'_>, view: &mut View) -> Result<()> {
    let step = view.history.recall_up(
        &view.session,
        view.generation,
        view.editor.text(),
        &view.draft_attachments,
    );
    run_step(client, view, step).await
}

/// ↓ 历史：到最新之后恢复首次保存的正文与附件，不发请求。
pub(crate) async fn history_down(client: &mut Client<'_>, view: &mut View) -> Result<()> {
    let step = view.history.recall_down(&view.session, view.generation);
    run_step(client, view, step).await
}

async fn run_step(client: &mut Client<'_>, view: &mut View, step: Step) -> Result<()> {
    match step {
        Step::Request(skip) => {
            let params = json!({"skip":skip});
            match client.start_query(
                view,
                QueryKind::History { skip },
                Method::InputHistoryRecall,
                params,
            ) {
                Ok(true) => {}
                // 通道满：本 tick 不发，释放 pending 让下一次真实 ↑ 重试。
                Ok(false) => view.history.request_failed(),
                Err(error) => {
                    view.history.request_failed();
                    view.push(&format!("Error: {error}"));
                }
            }
        }
        Step::Restore(draft) => restore(view, draft),
        Step::AtStart => {
            let note = view
                .text("No earlier input history.", "没有更早的输入历史。")
                .to_owned();
            view.push(&note);
        }
        Step::Unavailable => {
            let note = view
                .text(
                    "Input history is unavailable for this session.",
                    "当前会话的输入历史不可用。",
                )
                .to_owned();
            view.push(&note);
        }
        Step::Ignore => {}
    }
    Ok(())
}

fn apply_history(view: &mut View, reply: ReadReply) -> bool {
    let QueryKind::History { skip } = reply.kind else {
        return false;
    };
    if reply.session != view.session || reply.generation != view.generation {
        return false;
    }
    // 审批/问答、selector 或队列编辑会接管主 editor；同 session/generation 也不能把
    // 迟到的历史正文写进回答草稿。清掉 pending/revision，后续 ↑ 重新按当前上下文开始。
    if view.interaction().is_some() || view.selector.is_some() || view.queue_edit.is_some() {
        view.history.edited();
        return false;
    }
    let directory = view.directory.clone();
    let applied = view.history.apply(
        &view.session,
        view.generation,
        skip,
        reply.result,
        &directory,
    );
    match applied {
        Applied::Restore(draft) => {
            restore(view, draft);
            true
        }
        Applied::End => {
            let note = view
                .text("No earlier input history.", "没有更早的输入历史。")
                .to_owned();
            view.push(&note);
            true
        }
        Applied::Failed(error) => {
            let lowered = error.to_lowercase();
            if lowered.contains("unavailable") || lowered.contains("unsupported") {
                view.history.mark_unsupported();
            }
            view.push(&format!("Error: {error}"));
            true
        }
        Applied::Stale => false,
    }
}

/// 历史恢复只写未提交草稿；附件由 `DraftAttachments::from_history` 依据正文占位符重建。
fn restore(view: &mut View, draft: Draft) {
    view.editor.replace_all(&draft.text);
    view.draft_attachments = draft.attachments;
    view.sync_completion();
}
