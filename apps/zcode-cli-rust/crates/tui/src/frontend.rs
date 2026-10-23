//! 前端集成：Enter/Paste 分流、已完成结果的有界 poll，以及历史读写桥接。
//!
//! 这里不拥有会话事实：历史只从内部读票据取回，队列/审批/会话仍由 actor 提交后的
//! snapshot 驱动。所有回包（只读票据、draft mutation、boot/setting/queue/picker/snapshot
//! 续步）都由 [`Frontend::poll`] 从 Client 完成队列 drain，不 await 任何新 ACK；poll 只做
//! 有界本地工作，慢 admission 期间键盘/退出/重绘照常推进。
use crate::{
    client::{Client, QueryKind},
    commands,
    draft_attachments::DraftAttachments,
    editor::sanitize,
    frontend_history_apply::{apply_history, restore},
    input_history::Step,
    picker,
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
    /// Ctrl-D / `/quit` 的 root 退出意图：主循环据此取消共享 token 并立即返回。
    quit: bool,
}

impl Frontend {
    /// 启动时把 `--attach` 投影成第一份草稿的 pinned 附件；非法项整批报错。
    /// Ctrl-D/`/quit` 不等待 stop ACK：只记下 root 退出意图，由 transport 取消共享 token。
    pub(crate) fn request_quit(&mut self) {
        self.quit = true;
    }

    pub(crate) fn take_quit(&mut self) -> bool {
        std::mem::take(&mut self.quit)
    }

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

    /// 主循环每个 tick / 事件后调用：drain 只读票据与所有 workflow 回包并推进续步，
    /// 不 await 新回包；gaprepair 由 `Client::pump_flows` 以单飞只读 workflow 发出。
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
        // 唯一 mutation 回包结算点：accepted/rejected 与续步都按票据身份判定，
        // 绝不 await 新 ACK。结算后立即尝试发出续步/staged 请求与 gaprepair。
        dirty |= crate::frontend_operations::settle(client, view).await?;
        dirty |= client.pump_flows(view)?;
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
            // 旧世代 operation 的票据效果必须失效；已发送但结果未知的草稿转为旧 owner
            // pending（保留原 session 标签，只由用户显式恢复），绝不静默丢弃。
            let had_unknown = view.operations.has_unknown();
            if let Some(stranded) = view.operations.invalidate(view.generation) {
                if view.editor.text().is_empty() {
                    view.editor.replace_all(&stranded.text);
                    view.draft_attachments = stranded.attachments;
                } else {
                    let note = view
                        .text(
                            "An unknown-outcome draft could not be kept with the two recovery slots full; save your current draft and retry.",
                            "两个恢复槽都已占用，无法再保留结果未知的草稿；请先保存当前草稿后重试。",
                        )
                        .to_owned();
                    view.push(&note);
                }
            } else if !had_unknown && view.operations.has_unknown() {
                // 已发送但会话已换代：结果未知；草稿留在 alternate，必须由用户显式复核/丢弃。
                let note = view
                    .text(
                        "The in-flight draft was already sent, but the session changed before its result arrived. Its outcome is unknown; it was NOT resent or discarded. Use /draft swap to review it, or /draft discard to drop it.",
                        "在飞草稿已发送，但结果到达前会话已变化。结果未知；未自动重发，也未丢弃。使用 /draft swap 复核，或用 /draft discard 显式丢弃。",
                    )
                    .to_owned();
                view.push(&note);
            }
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

/// Enter 的唯一提交入口：先接受补全，再把草稿整份转移给唯一在飞 operation。
///
/// 普通正文与交互回答只发出、不等待 ACK；slash/本地命令仍保留原分流。已有 mutation
/// 在飞时明确拒绝并保留草稿，不重复 admission，也不在前端排队。
pub(crate) async fn submit_editor(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
) -> Result<bool> {
    view.accept_completion();
    // 恢复槽存在时新提交必须被拦，但 /draft、/help 等纯本地命令必须始终可执行：
    // 否则唯一能清空恢复槽的入口反被恢复槽自己挡住，形成死锁。
    if view.operations.has_rejected() && !commands::is_local(view.editor.text()) {
        let note = view
            .text(
                "A rejected draft is waiting. Use /draft swap to review it, or /draft discard to drop it (Ctrl-Y is a shortcut).",
                "还有一份被拒绝的草稿未处理。使用 /draft swap 复核，或用 /draft discard 丢弃（Ctrl-Y 是便捷方式）。",
            )
            .to_owned();
        view.push(&note);
        return Ok(false);
    }
    let interaction = view.interaction().is_some();
    let draft = view.editor.text().to_owned();
    let plain = !interaction && !draft.trim().is_empty() && !draft.starts_with('/');
    if !interaction && !plain {
        // slash/本地命令不占 mutation 槽；失败时只恢复正文，附件从未转移。
        let text = view.editor.clear();
        return match enter(client, view, request, &text).await {
            Ok(quit) => Ok(quit),
            Err(error) => {
                view.editor.replace_all(&text);
                view.push(&format!("Error: {error}"));
                Ok(false)
            }
        };
    }
    if view.operations.busy() {
        let note = view
            .text(
                "A previous operation is still waiting for the actor; this draft was kept and not sent.",
                "上一条操作仍在等待 actor 回包；本次草稿已保留，未发送。",
            )
            .to_owned();
        view.push(&note);
        return Ok(false);
    }
    let text = view.editor.clear();
    let result = if interaction {
        session::resolve_interaction(client, view, &text).await
    } else {
        session::submit(client, view, request, &text).await
    };
    match result {
        Ok(()) if !interaction => view.history.edited(),
        Ok(()) => {}
        Err(error) => {
            view.editor.replace_all(&text);
            view.push(&format!("Error: {error}"));
        }
    }
    Ok(false)
}

/// `/quit`、审批回答、slash 与普通正文的唯一分流点。
async fn enter(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<bool> {
    if matches!(text.trim(), "/quit" | "/exit") {
        // root 退出不等待 stop ACK、不撤销已接受输入；transport 负责取消共享 token。
        return Ok(true);
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
    // 纯本地命令不依赖 actor/session，任何时候都可执行（包括恢复槽存在/busy 时）。
    if commands::is_local(text) {
        return session::slash(client, view, request, text).await;
    }
    // boot/setting/queue 在飞时明确拒绝（不静默丢、不二次 admission）。
    if client.mutation_flow_busy() {
        return Err(crate::frontend_operations::busy_slash_error(view));
    }
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
