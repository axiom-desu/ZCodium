//! 队列编辑草稿的交互回归：拒绝保留、交互优先、世代失效。
use crate::{client::Client, queue, queue_test_support::*};
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
