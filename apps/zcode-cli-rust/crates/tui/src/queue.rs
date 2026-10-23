//! 真实队列 UI / 命令。
//!
//! 队列事实由 core actor 独占：本模块只把 `state.queue.items` 投影成 typed 菜单，
//! 菜单项与 `/queue <op> <id>` 共用同一份“捕获的 revision/logEpoch + 稳定 id”，
//! 通过既有 `Method::Command` 提交 `editQueueItem`/`deleteQueueItem`/
//! `reorderQueueItem`/`sendQueuedNow`/`setAutoDrain`。
//!
//! 边界：
//! - 不插入本地 user row、不修改 `state.queue.items`；成功/noop 后只回拉 actor 快照。
//! - stale/rejected 不自动重试、不按菜单下标猜最新 id；编辑失败保留本地草稿。
//! - `/queue` 精确首 token 归本模块（`/queuefoo` 仍是未知命令）。
//! - 权限/问答优先：`handle_key` 在交互期间不吃键盘，`QueueEdit` 文本绝不作为答案。
use crate::{
    client::Client, projection::View, queue_render, queue_state, selector::Choice, session,
};
use anyhow::{Result, ensure};
use ratatui::layout::Rect;
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

/// 队列模块公开的类型入口：selector/picker 只通过这里引用 typed 选择项。
// 集成层入口：按键优先级的 queue edit 分支经 `queue::handle_key` 调用。
#[allow(unused_imports)]
pub(crate) use crate::queue_edit::handle_key;
pub(crate) use crate::queue_menu::open;
pub(crate) use queue_state::{QueueChoice, QueueEdit, QueueOp};

/// 只有首 token 恰好是 `/queue` 的输入进入队列模块，避免吃掉未知命令。
pub(crate) fn handles(text: &str) -> bool {
    text.split_whitespace().next() == Some("/queue")
}

/// `/queue` 命令的唯一实现；返回值 `true` 表示“已由队列模块处理”（永远不是 quit）。
pub(crate) async fn dispatch(client: &mut Client<'_>, view: &mut View, text: &str) -> Result<bool> {
    match text.split_whitespace().collect::<Vec<_>>().as_slice() {
        ["/queue"] => view.selector = Some(open(view)?),
        ["/queue", "list"] => {
            let lines = queue_render::render_lines(view, 120);
            if lines.is_empty() {
                let note = view
                    .text("The queue is empty.", "当前没有排队输入。")
                    .to_owned();
                view.push(&note);
            } else {
                for line in lines {
                    view.push(&line);
                }
            }
        }
        ["/queue", "pause"] => set_auto_drain(client, view, false).await?,
        ["/queue", "resume"] => set_auto_drain(client, view, true).await?,
        ["/queue", op, id] => {
            let Some(op) = QueueOp::from_token(op) else {
                return Err(usage(view));
            };
            apply(client, view, op, id).await?;
        }
        _ => return Err(usage(view)),
    }
    Ok(true)
}

fn usage(view: &View) -> anyhow::Error {
    queue_state::local(
        view,
        "Usage: /queue [list|pause|resume|edit|delete|send|up|down <id>]".into(),
        "用法：/queue [list|pause|resume|edit|delete|send|up|down <id>]".into(),
    )
}

/// 菜单确认（由 `picker::confirm` 委派）：第一步开操作菜单，第二步提交 typed 操作。
pub(crate) async fn confirm(client: &mut Client<'_>, view: &mut View) -> Result<()> {
    let Some(selector) = view.selector.as_ref() else {
        return Ok(());
    };
    ensure!(
        selector.owner == view.session,
        "{}",
        queue_state::local(
            view,
            "Queue selection belongs to an old session.".into(),
            "队列选择属于旧会话。".into()
        )
    );
    let Some((choice, _)) = selector.choice() else {
        return Ok(());
    };
    let Choice::Queue(choice) = choice.clone() else {
        return Ok(());
    };
    let Some(op) = choice.op else {
        // 第一步只换菜单，仍保留原 selector.draft，Esc 可恢复原草稿。
        view.selector = Some(crate::queue_menu::menu(view, &choice)?);
        return Ok(());
    };
    let Some(item) = queue_state::find(view, &choice.queue_item_id).cloned() else {
        return Err(queue_state::stale(view, &choice.queue_item_id));
    };
    queue_state::ensure_queued(view, &item)?;
    if op == QueueOp::Edit {
        // 编辑不提交正文：只把原项投影成独立 QueueEdit 草稿。
        queue_state::ensure_editable(view, &item)?;
        start_edit(view, &item, &choice)?;
        view.selector = None;
        return Ok(());
    }
    let payload = crate::queue_menu::payload(view, &choice, op)?;
    mutate(
        client,
        view,
        op.kind(),
        payload,
        choice.revision,
        &choice.log_epoch,
    )
    .await?;
    // 只有 actor 接受并回拉成功后才关闭菜单；失败保留原选择器与草稿。
    view.selector = None;
    Ok(())
}

/// 带既有 payload 的 typed 操作（`/queue <op> <id>` 与菜单共用）。
async fn apply(client: &mut Client<'_>, view: &mut View, op: QueueOp, id: &str) -> Result<()> {
    let Some(item) = queue_state::find(view, id).cloned() else {
        return Err(queue_state::stale(view, id));
    };
    queue_state::ensure_queued(view, &item)?;
    let choice = QueueChoice {
        queue_item_id: id.to_owned(),
        op: Some(op),
        revision: queue_state::revision(view),
        log_epoch: queue_state::log_epoch(view),
    };
    if op == QueueOp::Edit {
        queue_state::ensure_editable(view, &item)?;
        return start_edit(view, &item, &choice);
    }
    let payload = crate::queue_menu::payload(view, &choice, op)?;
    mutate(
        client,
        view,
        op.kind(),
        payload,
        choice.revision,
        &choice.log_epoch,
    )
    .await
}

pub(crate) fn start_edit(view: &mut View, item: &Value, choice: &QueueChoice) -> Result<()> {
    view.queue_edit = Some(QueueEdit::from_item(
        view,
        item,
        choice.revision,
        &choice.log_epoch,
    ));
    let note = view
        .text(
            "Editing queued input · Enter save · Esc cancel",
            "正在编辑排队输入 · Enter 保存 · Esc 取消",
        )
        .to_owned();
    view.push(&note);
    Ok(())
}

async fn set_auto_drain(client: &mut Client<'_>, view: &mut View, enabled: bool) -> Result<()> {
    mutate(
        client,
        view,
        "setAutoDrain",
        json!({"autoDrain": enabled}),
        queue_state::revision(view),
        &queue_state::log_epoch(view),
    )
    .await
}

/// CAS 信封：命令 kind/payload 走既有 `Method::Command`，基线是打开菜单时捕获的值。
///
/// 公开给集成层与测试：`baseRevision`/`baseLogEpoch` 必须在信封层（payload 会被
/// 共享 schema 按 zod strip 语义裁剪）。
pub(crate) fn cas(
    session: &str,
    kind: &str,
    payload: Value,
    revision: u64,
    log_epoch: &str,
) -> Value {
    let mut command = session::command(session, kind, payload);
    command["baseRevision"] = revision.into();
    command["baseLogEpoch"] = log_epoch.into();
    command
}

/// 唯一提交路径：accepted/duplicate/noop 后回拉快照；stale/拒绝原样报错且不重试。
pub(crate) async fn mutate(
    client: &mut Client<'_>,
    view: &mut View,
    kind: &str,
    payload: Value,
    revision: u64,
    log_epoch: &str,
) -> Result<()> {
    let command = cas(&view.session, kind, payload, revision, log_epoch);
    let ack = client.call(view, Method::Command, command).await?;
    match ack["status"].as_str().unwrap_or_default() {
        "accepted" | "duplicate" | "noop" => {
            // 队列事实只来自 actor：回拉快照，本地不插/不改 queue items。
            client.refresh(view).await
        }
        "stale" => {
            // actor 的 reasonCode 是这次拒绝的真实原因（revision/logEpoch/已消费等），
            // 不能换成笼统的本地提示把它丢掉。
            let code = ack["reasonCode"].as_str().unwrap_or("stale");
            Err(queue_state::local(
                view,
                format!("The queue changed before this action ({code}); reopen /queue and retry."),
                format!("队列在你操作前已变化（{code}）；请重新打开 /queue 再试。"),
            ))
        }
        _ => {
            let code = ack["reasonCode"].as_str().unwrap_or_default();
            let message = ack["message"]
                .as_str()
                .filter(|message| !message.is_empty())
                .unwrap_or(code);
            Err(queue_state::local(
                view,
                format!("Queue command was not applied: {message}"),
                format!("队列命令未生效：{message}"),
            ))
        }
    }
}

/// composer 上方队列条（供集成层在正文与编辑器之间渲染）。
pub(crate) fn render_lines(view: &View, width: usize) -> Vec<String> {
    queue_render::render_lines(view, width)
}

/// 队列编辑弹层（供集成层在 presentation 中调用）。
pub(crate) fn draw_edit(frame: &mut ratatui::Frame<'_>, bounds: Rect, view: &View) {
    queue_render::draw_edit(frame, bounds, view);
}
