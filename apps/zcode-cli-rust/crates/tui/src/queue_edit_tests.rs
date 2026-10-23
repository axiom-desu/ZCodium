//! 队列编辑草稿的交互回归：拒绝保留、交互优先、世代失效。
use crate::{
    client::Client, frontend_test_support::drive, queue, queue_edit, queue_test_support::*,
};
use crossterm::event::KeyCode;
use serde_json::json;
use zcode_cli_core_api::Method;

#[tokio::test]
async fn edit_commit_sends_cas_edit_and_keeps_the_draft_when_rejected() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let ((to, mut from), actor, recorded) = endpoints(vec![
        json!({"status":"rejected","reasonCode":"guard.queueItemNotEditable","message":"not editable"}),
    ]);
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap();
    assert!(view.queue_edit.is_some());
    if let Some(edit) = view.queue_edit.as_mut() {
        edit.editor.replace_all("edited text");
    }
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Enter))
            .await
            .unwrap()
    );

    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].0, Method::Command.as_str());
    let params = &recorded[0].1;
    assert_eq!(params["type"], "editQueueItem");
    assert_eq!(params["payload"]["queueItemId"], "q1");
    assert_eq!(params["payload"]["newText"], "edited text");
    assert_eq!(params["baseRevision"], 7);
    assert_eq!(params["baseLogEpoch"], "epoch-1");
    // 真实协议解析不得 strip 正文或 CAS 字段。
    let parsed = zcode_cli_protocol::parse_command(params).expect("canonical edit command");
    assert_eq!(parsed.payload["newText"], "edited text");
    assert_eq!(parsed.base_revision, Some(7.0));

    // 拒绝后保留本地草稿与错误；不自动重试、不伪造成功。
    assert_eq!(view.queue_edit.as_ref().unwrap().text(), "edited text");
    assert!(
        view.notices
            .iter()
            .any(|note| note.contains("not editable"))
    );
    actor.await.unwrap();
}

#[tokio::test]
async fn pending_interaction_pauses_the_edit_and_never_answers_with_queued_text() {
    let mut view = queue_view(json!([item("q1", "sendText", "queued answer")]), false);
    let ((to, mut from), actor, recorded) = endpoints(Vec::new());
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap();
    view.state["pendingInteractions"] = json!([{"interactionId":"p1","kind":"permission"}]);
    // 权限期间：编辑弹层暂停且不吃键盘，main editor 仍是回答通道。
    assert!(
        !queue::handle_key(&mut client, &mut view, key(KeyCode::Char('n')))
            .await
            .unwrap()
    );
    assert!(
        !queue::handle_key(&mut client, &mut view, key(KeyCode::Enter))
            .await
            .unwrap()
    );
    assert_eq!(view.queue_edit.as_ref().unwrap().text(), "queued answer");
    assert!(view.editor.text().is_empty());
    assert!(recorded.lock().unwrap().is_empty());
    // 交互结束后按键仍归属编辑弹层。
    view.state["pendingInteractions"] = json!([]);
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Char('!')))
            .await
            .unwrap()
    );
    assert_eq!(view.queue_edit.as_ref().unwrap().text(), "queued answer!");
    actor.await.unwrap();
}

#[tokio::test]
async fn escaping_the_edit_drops_it_and_generation_change_keeps_it_stale_until_escape() {
    let mut view = queue_view(json!([item("q1", "sendText", "a")]), false);
    let ((to, mut from), actor, _recorded) = endpoints(Vec::new());
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap();
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Esc))
            .await
            .unwrap()
    );
    assert!(view.queue_edit.is_none());

    queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap();
    view.generation += 1;
    // 旧世代：非 Esc 键被消费但不 mutation，也不丢草稿。
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Char('x')))
            .await
            .unwrap()
    );
    assert_eq!(view.queue_edit.as_ref().unwrap().text(), "a");
    assert!(view.queue_edit.as_ref().unwrap().generation < view.generation);
    // Enter 同样不能提交旧世代编辑或落到主 editor。
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Enter))
            .await
            .unwrap()
    );
    assert!(view.queue_edit.is_some());
    // Esc 才取消失效缓冲。
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Esc))
            .await
            .unwrap()
    );
    assert!(view.queue_edit.is_none());
    actor.await.unwrap();
}

/// 保存队列编辑时 baseRevision 必须是“打开编辑时捕获”的版本，不能被期间的新快照覆盖。
#[tokio::test]
async fn edit_save_keeps_the_revision_captured_when_the_editor_opened() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let ((to, mut from), actor, recorded) = endpoints(vec![
        json!({"status":"accepted"}),
        snapshot_reply(json!([item(
            "q1",
            "sendText",
            "edited after revision bump"
        )])),
    ]);
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap();
    // 编辑打开后 actor 快照推进了队列 revision：保存仍用打开时的 CAS 基线 7。
    view.state["revision"] = json!(9);
    if let Some(edit) = view.queue_edit.as_mut() {
        edit.editor.replace_all("edited after revision bump");
    }
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Enter))
            .await
            .unwrap()
    );
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded[0].1["baseRevision"], 7);
    assert_eq!(
        recorded[0].1["payload"]["newText"],
        "edited after revision bump"
    );
    actor.await.unwrap();
}

/// 真实两轮保存：第一次 accepted+snapshot 后保留稿必须拿到 committed revision，
/// 用户再次 Enter 用新基线显式保存成功，而不是必然 stale。
#[tokio::test]
async fn retained_edit_rebases_from_the_committed_snapshot_and_saves_twice() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let ((to, mut from), actor, recorded) = endpoints(vec![
        json!({"status":"accepted"}),
        snapshot_reply(json!([item("q1", "sendText", "edited text")])),
        json!({"status":"accepted"}),
        snapshot_reply(json!([item("q1", "sendText", "edited text +more")])),
    ]);
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap();
    if let Some(edit) = view.queue_edit.as_mut() {
        edit.editor.replace_all("edited text");
    }
    // 真实 keyboard 与测试共用同步提交入口；在 fake actor 的回包被处理前继续编辑。
    assert!(queue_edit::begin_commit(&mut client, &mut view).unwrap());
    if let Some(edit) = view.queue_edit.as_mut() {
        edit.editor.insert(" +more");
    }
    drive(&mut client, &mut view).await;
    let edit = view.queue_edit.as_ref().expect("保存期间继续编辑必须保留");
    assert_eq!(edit.text(), "edited text +more");
    assert_eq!(edit.revision, 8, "保留稿必须推进到 committed revision");
    assert_eq!(edit.log_epoch, "epoch-1");
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Enter))
            .await
            .unwrap()
    );
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded.len(), 4);
    assert_eq!(recorded[2].0, Method::Command.as_str());
    assert_eq!(recorded[2].1["baseRevision"], 8, "第二轮必须用新基线");
    assert_eq!(recorded[2].1["baseLogEpoch"], "epoch-1");
    assert_eq!(recorded[2].1["payload"]["newText"], "edited text +more");
    assert!(view.queue_edit.is_none(), "第二轮同版本保存后关闭");
    assert!(
        !view.notices.iter().any(|note| note.contains("not retried")),
        "没有保留稿时不能误报冲突"
    );
    actor.await.unwrap();
}

/// 保存后用户只敲了一个换行：exact 比较必须保留，不能被 trim 当无改清稿。
#[tokio::test]
async fn newline_typed_before_ack_keeps_the_draft() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let ((to, mut from), actor, recorded) = endpoints(vec![
        json!({"status":"accepted"}),
        snapshot_reply(json!([item("q1", "sendText", "edited text")])),
    ]);
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap();
    if let Some(edit) = view.queue_edit.as_mut() {
        edit.editor.replace_all("edited text");
    }
    assert!(queue_edit::begin_commit(&mut client, &mut view).unwrap());
    if let Some(edit) = view.queue_edit.as_mut() {
        edit.editor.insert("\n");
    }
    drive(&mut client, &mut view).await;
    let edit = view.queue_edit.as_ref().expect("只加换行也必须保留");
    assert_eq!(edit.text(), "edited text\n");
    assert_eq!(edit.revision, 8);
    assert_eq!(recorded.lock().unwrap().len(), 2, "不得自动重试");
    actor.await.unwrap();
}

/// 快照证明 item 已被消耗/正文被外部改动：只保稿并报告冲突，不自动重试第二次保存。
#[tokio::test]
async fn consumed_or_externally_changed_item_keeps_the_draft_without_retry() {
    for snapshot_items in [
        json!([]),
        json!([item("q1", "sendText", "changed by another owner")]),
    ] {
        let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
        let ((to, mut from), actor, recorded) = endpoints(vec![
            json!({"status":"accepted"}),
            snapshot_reply(snapshot_items),
        ]);
        let mut client = Client::new(&to, &mut from);
        queue::dispatch(&mut client, &mut view, "/queue edit q1")
            .await
            .unwrap();
        if let Some(edit) = view.queue_edit.as_mut() {
            edit.editor.replace_all("edited text");
        }
        assert!(queue_edit::begin_commit(&mut client, &mut view).unwrap());
        // 先发送 sent_text，再在处理回包前敲入更新文本；外部快照与所发版本不同。
        if let Some(edit) = view.queue_edit.as_mut() {
            edit.editor.replace_all("my newer edit");
        }
        drive(&mut client, &mut view).await;
        let edit = view.queue_edit.as_ref().expect("冲突时原稿必须保留");
        assert_eq!(edit.text(), "my newer edit");
        assert_eq!(edit.revision, 7, "未自动推进到不可信 revision");
        assert!(
            view.notices
                .iter()
                .any(|note| note.contains("not retried") || note.contains("未自动重试")),
            "{:?}",
            view.notices.last()
        );
        assert_eq!(recorded.lock().unwrap().len(), 2, "不得自动重试");
        actor.await.unwrap();
    }
}
