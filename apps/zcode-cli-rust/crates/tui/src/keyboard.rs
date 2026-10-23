//! 按键优先级：全局退出/取消 > 权限问答 > 队列编辑 > 选择器 > @file > 补全 > 历史 > editor。
//!
//! 这里只搬运用户意图；所有事实仍通过既有 Client/actor 端口提交，历史与文件候选只读本地草稿。
use crate::{
    client::Client, frontend, projection::View, queue, queue_edit, queue_render, session,
    transport::Request,
};
use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// 返回 `true` 表示退出 TUI。实际键路径与真实 `run` 循环共用这个函数。
pub(crate) async fn handle(
    frontend: &mut frontend::Frontend,
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    key: KeyEvent,
    narrow: bool,
) -> Result<bool> {
    // Ctrl-X 是两键前缀；任何其他键都会先清掉 leader，避免误触发侧栏。
    if key.code != KeyCode::Char('b')
        && !(key.code == KeyCode::Char('x') && key.modifiers.contains(KeyModifiers::CONTROL))
    {
        frontend.sidebar_leader = false;
    }
    // 全局退出/取消最高优先级：弹窗、队列编辑或读票据都不能吞掉它。
    if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c' | 'd'))
    {
        let was_busy = view.busy();
        if was_busy && let Err(error) = session::stop(client, view).await {
            view.push(&error.to_string());
        }
        if key.code == KeyCode::Char('d') || !was_busy {
            return Ok(true);
        }
        view.selector = None;
        view.queue_edit = None;
        view.completion.dismiss();
        return Ok(false);
    }
    // 多行换行在所有交互中都是正文换行（队列编辑进自己的 buffer）。
    if key.code == KeyCode::Enter
        && key
            .modifiers
            .intersects(KeyModifiers::SHIFT | KeyModifiers::ALT)
    {
        if view.interaction().is_none() && view.queue_edit.is_some() {
            let stale = view
                .queue_edit
                .as_ref()
                .is_some_and(|edit| !queue_render::is_current(view, edit));
            if stale {
                // 旧世代编辑不接受任何 mutation，也不能把换行写进 main editor。
                queue_edit::stale_notice(view);
                return Ok(false);
            }
            if let Some(edit) = view.queue_edit.as_mut() {
                edit.editor.insert("\n");
            }
            return Ok(false);
        }
        view.history.edited();
        view.editor.insert("\n");
        return Ok(false);
    }
    // 权限/问答：主 editor 专门用于回答；只有 Enter 提交答案。
    if view.interaction().is_some() {
        if key.code == KeyCode::Enter {
            return frontend::submit_editor(client, view, request).await;
        }
        edit_move(view, key);
        return Ok(false);
    }
    // 队列编辑拥有独立草稿；未被它消费的键也不能落到主 editor/历史。
    if view.queue_edit.is_some() {
        if queue::handle_key(client, view, key).await? {
            return Ok(false);
        }
        if view.queue_edit.is_some() {
            scroll(view, key);
            return Ok(false);
        }
        // stale 编辑已被清除：继续走普通优先级。
    }
    if view.selector.is_some() {
        selector_key(client, view, request, key).await?;
        return Ok(false);
    }
    if view.file_mentions.visible() {
        let consumed = match key.code {
            KeyCode::Esc => {
                view.file_mentions.dismiss();
                true
            }
            KeyCode::Up => {
                view.file_mentions.move_by(-1);
                true
            }
            KeyCode::Down => {
                view.file_mentions.move_by(1);
                true
            }
            KeyCode::Enter | KeyCode::Tab => {
                let accepted = view
                    .file_mentions
                    .accept(&mut view.editor, &mut view.draft_attachments)?;
                if let Some(notice) = view.file_mentions.notice().map(str::to_owned) {
                    view.push(&notice);
                }
                if accepted {
                    view.history.edited();
                }
                accepted
            }
            _ => false,
        };
        if consumed {
            return Ok(false);
        }
    }
    if view.completion.visible() {
        match key.code {
            KeyCode::Esc => {
                view.completion.dismiss();
                return Ok(false);
            }
            KeyCode::Up => {
                view.completion.move_by(-1);
                return Ok(false);
            }
            KeyCode::Down => {
                view.completion.move_by(1);
                return Ok(false);
            }
            KeyCode::Enter => {
                if closed_submit_blocked(view) {
                    return Ok(false);
                }
                return frontend::submit_editor(client, view, request).await;
            }
            KeyCode::Tab => {
                view.accept_completion();
                view.history.edited();
                return Ok(false);
            }
            _ => {}
        }
    }
    match (key.code, key.modifiers) {
        (KeyCode::Char('x'), modifiers) if modifiers.contains(KeyModifiers::CONTROL) => {
            frontend.sidebar_leader = true;
        }
        (KeyCode::Char('b'), modifiers) if frontend.sidebar_leader && modifiers.is_empty() => {
            if narrow {
                view.sidebar_overlay = !view.sidebar_overlay;
            } else {
                view.sidebar = !view.sidebar;
                view.sidebar_overlay = false;
            }
            frontend.sidebar_leader = false;
        }
        (KeyCode::Esc, _) if view.sidebar_overlay => view.sidebar_overlay = false,
        (KeyCode::Enter, _) => {
            if closed_submit_blocked(view) {
                return Ok(false);
            }
            if frontend::submit_editor(client, view, request).await? {
                return Ok(true);
            }
            view.follow = true;
        }
        (KeyCode::Tab, _) => {
            view.accept_completion();
            view.history.edited();
        }
        (KeyCode::Char('u'), modifiers) if modifiers.contains(KeyModifiers::CONTROL) => {
            // 只清主 editor；队列编辑/选择器有各自 filter，不能被 Ctrl-U 误清。
            view.editor.clear();
            view.history.edited();
        }
        // ↑ 只在首行召回历史；多行其余行保留光标垂直移动，PageUp/Down 仍滚正文。
        (KeyCode::Up, _) => {
            if !view.editor.up() {
                frontend::history_up(client, view).await?;
            }
        }
        (KeyCode::Down, _) => {
            if !view.editor.down() {
                frontend::history_down(client, view).await?;
            }
        }
        (KeyCode::PageUp, _) => {
            view.follow = false;
            view.scroll = view.scroll.saturating_sub(5);
        }
        (KeyCode::PageDown, _) => {
            view.follow = false;
            view.scroll = view.scroll.saturating_add(5);
        }
        _ => {
            edit_move(view, key);
        }
    }
    Ok(false)
}

/// TopicClosed 后主 submit 本地拒绝，直到 /new 或 /resume 重新打开 owner；
/// 草稿留在 editor，不通过新进程或自动重开掩盖终态。
fn closed_submit_blocked(view: &mut View) -> bool {
    if !view.topic_closed {
        return false;
    }
    let first = view
        .editor
        .text()
        .split_whitespace()
        .next()
        .unwrap_or_default();
    if matches!(first, "/new" | "/resume") {
        return false;
    }
    let note = view
        .text(
            "This session is closed; the draft was kept. Use /new or /resume before sending.",
            "当前会话已关闭，草稿已保留。请先使用 /new 或 /resume 再发送。",
        )
        .to_owned();
    view.push(&note);
    true
}

/// 选择器只在本地过滤，确认真实选择仍交给 picker/queue。
async fn selector_key(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    key: KeyEvent,
) -> Result<()> {
    match key.code {
        KeyCode::Esc => {
            if let Some(selector) = view.selector.take() {
                view.editor.replace_all(&selector.draft);
                view.history.edited();
            }
        }
        KeyCode::Up => {
            if let Some(selector) = view.selector.as_mut() {
                selector.move_by(-1);
            }
        }
        KeyCode::Down => {
            if let Some(selector) = view.selector.as_mut() {
                selector.move_by(1);
            }
        }
        KeyCode::Backspace => {
            if let Some(selector) = view.selector.as_mut() {
                selector.backspace_filter();
            }
        }
        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            if let Some(selector) = view.selector.as_mut() {
                selector.clear_filter();
            }
        }
        KeyCode::Char(c)
            if !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            if let Some(selector) = view.selector.as_mut() {
                selector.push_filter(&c.to_string());
            }
        }
        KeyCode::Enter => {
            if let Err(error) = crate::picker::confirm(client, view, request).await {
                view.push(&error.to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

/// 纯编辑/光标键；真实编辑会让在飞历史结果失效。
fn edit_move(view: &mut View, key: KeyEvent) {
    let edited = match (key.code, key.modifiers) {
        (KeyCode::Char(c), modifiers)
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            view.editor.insert(&c.to_string());
            true
        }
        (KeyCode::Backspace, _) => {
            view.editor.backspace();
            true
        }
        (KeyCode::Delete, _) => {
            view.editor.delete();
            true
        }
        (KeyCode::Left, _) => {
            view.editor.left();
            false
        }
        (KeyCode::Right, _) => {
            view.editor.right();
            false
        }
        (KeyCode::Home, _) => {
            view.editor.home();
            false
        }
        (KeyCode::End, _) => {
            view.editor.end();
            false
        }
        _ => false,
    };
    if edited {
        view.history.edited();
    }
}

fn scroll(view: &mut View, key: KeyEvent) {
    match key.code {
        KeyCode::PageUp => {
            view.follow = false;
            view.scroll = view.scroll.saturating_sub(5);
        }
        KeyCode::PageDown => {
            view.follow = false;
            view.scroll = view.scroll.saturating_add(5);
        }
        _ => {}
    }
}
