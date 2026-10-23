//! 恢复槽死锁与“结果未知”草稿的前端回归。
use crate::{
    client::Client,
    frontend::{self, Frontend},
    frontend_test_support::{endpoints, key, next_request, request, view},
    keyboard,
};
use crossterm::event::KeyCode;
use serde_json::json;

/// 恢复槽存在且 actor 正在运行时，唯一的恢复命令 `/draft discard` 必须仍可执行。
#[tokio::test]
async fn local_draft_discard_works_while_busy_and_rejected() {
    use crate::operations::{OpKind, SentDraft};
    let req = request();
    let (to, mut requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.state["control"]["canStop"] = json!(true);
    view.operations
        .begin(
            OpKind::Submit,
            "s",
            view.generation,
            Some(SentDraft::new("old", Default::default())),
        )
        .unwrap();
    view.operations
        .rejected("s", view.generation, OpKind::Submit, None);
    view.editor.replace_all("/draft discard");
    view.sync_completion();
    view.completion.dismiss();
    let mut frontend = Frontend::default();
    keyboard::handle(
        &mut frontend,
        &mut client,
        &mut view,
        &req,
        key(KeyCode::Enter),
        false,
    )
    .await
    .unwrap();
    assert!(!view.operations.has_rejected(), "恢复命令不得被恢复槽挡住");
    assert!(view.editor.text().is_empty());
    assert!(requests.try_recv().is_err(), "/draft 不得产生请求");
    assert!(view.notices.iter().any(|note| note.contains("discarded")));
}

/// 会话换代后已发送草稿结果未知：不得自动恢复/重发/删除，必须留下显式复核提示。
#[tokio::test]
async fn generation_change_surfaces_unknown_outcome_without_restoring_it() {
    let req = request();
    let (to, mut requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("sent before close");
    view.sync_completion();
    frontend::submit_editor(&mut client, &mut view, &req)
        .await
        .unwrap();
    assert!(view.editor.text().is_empty());
    let _ = next_request(&mut requests).await;
    view.generation = view.generation.wrapping_add(1);
    Frontend::default().after_change(&mut view);
    assert!(view.operations.has_unknown());
    assert!(
        view.editor.text().is_empty(),
        "结果未知的草稿不得自动恢复到编辑器"
    );
    assert!(
        view.notices
            .iter()
            .any(|note| note.contains("outcome is unknown") && note.contains("/draft swap")),
        "{:?}",
        view.notices
    );
    assert!(requests.try_recv().is_err(), "结果未知不得自动重发");
}
