//! 队列编辑交互：独立 `QueueEdit` 草稿的按键归属与提交。
use crate::{
    client::Client, flow_queue::SentEdit, projection::View, queue::Settle, queue::begin_mutate,
    queue_render, queue_state,
};
use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;

/// 队列编辑的按键归属：打印/移动/Enter 提交/Esc 取消；交互期间暂停且不吃键。
pub(crate) async fn handle_key(
    client: &mut Client<'_>,
    view: &mut View,
    key: KeyEvent,
) -> Result<bool> {
    // 权限/问答优先：编辑弹层只暂停，键盘仍给 main editor 回答，排队正文不会变答案。
    if view.interaction().is_some() {
        return Ok(false);
    }
    if let Some(edit) = view.queue_edit.as_ref() {
        if !queue_render::is_current(view, edit) {
            // TopicClosed/旧世代：保留同一编辑 buffer 到用户 Esc，不静默丢弃，
            // 也不让触发键落到 main editor 把已关闭会话的草稿发到新会话。
            if key.code == KeyCode::Esc {
                view.queue_edit = None;
                let note = view
                    .text("Stale queue edit cancelled.", "已取消失效的排队编辑。")
                    .to_owned();
                view.push(&note);
            } else {
                stale_notice(view);
            }
            return Ok(true);
        }
    } else {
        return Ok(false);
    }
    match key.code {
        KeyCode::Esc => {
            view.queue_edit = None;
            let note = view
                .text("Queue edit cancelled.", "已取消排队编辑。")
                .to_owned();
            view.push(&note);
            Ok(true)
        }
        KeyCode::Enter
            if !key
                .modifiers
                .intersects(KeyModifiers::SHIFT | KeyModifiers::ALT) =>
        {
            commit(client, view).await
        }
        _ => {
            let Some(edit) = view.queue_edit.as_mut() else {
                return Ok(false);
            };
            let editor = &mut edit.editor;
            match (key.code, key.modifiers) {
                (KeyCode::Enter, _) => editor.insert("\n"),
                (KeyCode::Char(c), modifiers)
                    if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    editor.insert(&c.to_string());
                }
                (KeyCode::Backspace, _) => editor.backspace(),
                (KeyCode::Delete, _) => editor.delete(),
                (KeyCode::Left, _) => editor.left(),
                (KeyCode::Right, _) => editor.right(),
                (KeyCode::Home, _) => editor.home(),
                (KeyCode::End, _) => editor.end(),
                // 其余键（滚动等）不被编辑弹层吞掉。
                _ => return Ok(false),
            }
            Ok(true)
        }
    }
}

/// 失效编辑的可见原因：只提示一次，不删除草稿、不模拟队列事实。
pub(crate) fn stale_notice(view: &mut View) {
    let note = view
        .text(
            "This queue edit belongs to a closed session or an old generation; the original draft is kept but cannot be submitted. Press Esc to cancel.",
            "该排队编辑属于已关闭的会话或旧世代；原草稿已保留但无法提交。按 Esc 取消。",
        )
        .to_owned();
    if view.notices.last() != Some(&note) {
        view.push(&note);
    }
}

/// Enter 提交：空文本/reserved/stale 一律本地拒绝；失败保留编辑文本，不自动重试。
async fn commit(client: &mut Client<'_>, view: &mut View) -> Result<bool> {
    let handled = begin_commit(client, view)?;
    #[cfg(test)]
    crate::frontend_test_support::drive(client, view).await;
    Ok(handled)
}

/// 同步登记一次保存：真实键盘与测试共用这一入口，测试可在回包前继续编辑。
pub(crate) fn begin_commit(client: &mut Client<'_>, view: &mut View) -> Result<bool> {
    let Some(edit) = view.queue_edit.as_ref() else {
        return Ok(false);
    };
    let raw_editor_text = edit.text().to_owned();
    let text = raw_editor_text.trim().to_owned();
    let (id, revision, log_epoch) = (
        edit.queue_item_id.clone(),
        edit.revision,
        edit.log_epoch.clone(),
    );
    if text.is_empty() {
        let note = view
            .text("Queued text cannot be empty.", "排队正文不能为空。")
            .to_owned();
        view.push(&note);
        return Ok(true);
    }
    let problem = match queue_state::find(view, &id) {
        None => Some(queue_state::stale(view, &id)),
        Some(item) => queue_state::ensure_editable(view, item).err(),
    };
    if let Some(error) = problem {
        view.push(&format!("Error: {error}"));
        return Ok(true);
    }
    let payload = json!({"queueItemId": id.clone(), "newText": text.clone()});
    // 只登记保存 workflow：accepted 后由它比较“所发的这一版”再结算本地编辑，
    // 保存期间继续输入的新文字不会被迟到的 OK 清空；失败/stale 原稿保留。
    let sent = SentEdit {
        queue_item_id: id,
        revision,
        log_epoch: log_epoch.clone(),
        text,
        raw_editor_text,
        generation: view.generation,
    };
    if let Err(error) = begin_mutate(
        client,
        view,
        "editQueueItem",
        payload,
        revision,
        &log_epoch,
        Settle {
            edit: Some(sent),
            close_selector: false,
        },
    ) {
        view.push(&format!("Error: {error}"));
    }
    Ok(true)
}
