//! 历史回包与真实 Paste/交互优先级的集成回归（fake runtime，不阻塞 actor）。
use crate::{
    client::Client,
    draft_attachments::DraftAttachments,
    frontend::{self, Frontend},
    frontend_test_support::{
        draft_with, endpoints, key, next_request, observe_next, reply, request, view,
    },
    input_history::{Applied, Step},
    keyboard,
    queue::QueueEdit,
    queue_test_support::{item, queue_view},
    selector::{Choice, Selector},
};
use crossterm::event::KeyCode;
use serde_json::json;

fn permission() -> serde_json::Value {
    json!([{
        "interactionId": "i1", "kind": "permission",
        "payload": {"toolName":"Bash","summary":"run",
            "options":[{"optionId":"allowOnce","label":"Allow"}]}
    }])
}

async fn start_history_read(
    frontend: &mut Frontend,
    client: &mut Client<'_>,
    view: &mut crate::projection::View,
    requests: &mut tokio::sync::mpsc::Receiver<zcode_cli_core_api::ClientMsg>,
) -> u64 {
    assert!(
        !keyboard::handle(frontend, client, view, &request(), key(KeyCode::Up), false)
            .await
            .unwrap()
    );
    let (token, method, params) = next_request(requests).await;
    assert_eq!(method, "internal/inputHistory/recall");
    assert_eq!(params["skip"], 0);
    token
}

#[tokio::test]
async fn paste_while_a_history_read_is_pending_keeps_the_pasted_draft_and_attachment() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("draft");
    let mut frontend = Frontend::default();
    let token = start_history_read(&mut frontend, &mut client, &mut view, &mut requests).await;

    frontend::paste_into(&mut view, "pasted @a.txt");
    view.draft_attachments = draft_with("a.txt", 4);
    frontend.after_change(&mut view);

    reply(&responses, token, json!({"text":"old","attachments":[]})).await;
    observe_next(&mut client, &mut view).await;
    frontend.poll(&mut client, &mut view).await.unwrap();

    assert_eq!(
        view.editor.text(),
        "draftpasted @a.txt",
        "迟到回包不能覆盖粘贴"
    );
    assert_eq!(
        view.draft_attachments
            .refs_for_text(view.editor.text())
            .len(),
        1,
        "粘贴后的附件草稿不能被历史回包替换"
    );
}

#[tokio::test]
async fn history_reply_does_not_write_the_answer_while_a_permission_is_pending() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("typed answer");
    let mut frontend = Frontend::default();
    let token = start_history_read(&mut frontend, &mut client, &mut view, &mut requests).await;

    view.state = json!({"pendingInteractions": permission()});
    reply(&responses, token, json!({"text":"old","attachments":[]})).await;
    observe_next(&mut client, &mut view).await;
    frontend.poll(&mut client, &mut view).await.unwrap();

    assert_eq!(view.editor.text(), "typed answer", "历史不能写进回答草稿");
    assert!(view.interaction().is_some());
    assert_eq!(
        view.state["pendingInteractions"].as_array().unwrap().len(),
        1
    );
    assert!(requests.try_recv().is_err(), "历史回包不能自动解决审批");
}

#[tokio::test]
async fn history_reply_does_not_replace_the_draft_while_a_selector_or_queue_edit_is_open() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("live draft");
    let mut frontend = Frontend::default();
    let token = start_history_read(&mut frontend, &mut client, &mut view, &mut requests).await;

    view.selector = Some(
        Selector::new(
            "Models".into(),
            vec![(Choice::Mode("build".into()), "build".into())],
            "s".into(),
            "live draft".into(),
        )
        .unwrap(),
    );
    reply(&responses, token, json!({"text":"old","attachments":[]})).await;
    observe_next(&mut client, &mut view).await;
    frontend.poll(&mut client, &mut view).await.unwrap();
    assert_eq!(view.editor.text(), "live draft");
    assert!(view.selector.is_some());
    assert!(view.selector.as_ref().unwrap().filter.is_empty());

    // 同一路径在队列编辑打开时也不能把历史写回主编辑器的回答草稿。
    view.selector = None;
    let token = start_history_read(&mut frontend, &mut client, &mut view, &mut requests).await;
    let base = queue_view(json!([item("q1", "sendText", "queued")]), false);
    view.queue_edit = Some(QueueEdit::from_item(
        &base,
        &item("q1", "sendText", "queued"),
        7,
        "epoch-1",
    ));
    reply(&responses, token, json!({"text":"old","attachments":[]})).await;
    observe_next(&mut client, &mut view).await;
    frontend.poll(&mut client, &mut view).await.unwrap();
    assert_eq!(view.editor.text(), "live draft");
    assert!(view.queue_edit.is_some());
}

#[tokio::test]
async fn accepted_prompt_after_an_exhausted_null_reopens_recall() {
    let req = request();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("draft");
    let mut frontend = Frontend::default();
    let token = start_history_read(&mut frontend, &mut client, &mut view, &mut requests).await;

    reply(&responses, token, serde_json::Value::Null).await;
    observe_next(&mut client, &mut view).await;
    frontend.poll(&mut client, &mut view).await.unwrap();
    assert_eq!(view.editor.text(), "draft");

    view.editor.replace_all("fresh prompt");
    view.sync_completion();
    let (result, params) = tokio::join!(
        frontend::submit_editor(&mut client, &mut view, &req),
        async {
            let (token, method, params) = next_request(&mut requests).await;
            assert_eq!(method, "v4/command");
            reply(&responses, token, json!({"status":"accepted"})).await;
            params
        }
    );
    assert!(!result.unwrap());
    assert_eq!(params["type"], "sendText");
    assert!(view.editor.text().is_empty());

    // 已被 actor 接受的新 prompt 可能立刻成为历史首项：↑ 必须重新发请求。
    let _ = start_history_read(&mut frontend, &mut client, &mut view, &mut requests).await;
}

#[test]
fn paste_into_selector_or_queue_edit_keeps_the_main_history_pending() {
    let attachments = DraftAttachments::default();
    let mut selector_view = view();
    selector_view.editor.insert("live draft");
    assert!(matches!(
        selector_view
            .history
            .recall_up("s", 0, "live draft", &attachments),
        Step::Request(0)
    ));
    selector_view.selector = Some(
        Selector::new(
            "Models".into(),
            vec![(Choice::Mode("build".into()), "build".into())],
            "s".into(),
            "live draft".into(),
        )
        .unwrap(),
    );
    frontend::paste_into(&mut selector_view, "fil");
    assert_eq!(selector_view.editor.text(), "live draft");
    assert_eq!(selector_view.selector.as_ref().unwrap().filter, "fil");
    assert!(matches!(
        selector_view
            .history
            .apply("s", 0, 0, Ok(json!({"text":"old","attachments":[]})), "/ws"),
        Applied::Restore(_)
    ));

    let mut queued_view = view();
    queued_view.editor.insert("live draft");
    assert!(matches!(
        queued_view
            .history
            .recall_up("s", 0, "live draft", &attachments),
        Step::Request(0)
    ));
    let base = queue_view(json!([item("q1", "sendText", "queued")]), false);
    let mut edit = QueueEdit::from_item(&base, &item("q1", "sendText", "queued"), 7, "epoch-1");
    edit.editor.clear();
    queued_view.queue_edit = Some(edit);
    frontend::paste_into(&mut queued_view, "queued paste");
    assert_eq!(
        queued_view.queue_edit.as_ref().unwrap().editor.text(),
        "queued paste"
    );
    assert_eq!(queued_view.editor.text(), "live draft");
    assert!(matches!(
        queued_view
            .history
            .apply("s", 0, 0, Ok(json!({"text":"old","attachments":[]})), "/ws"),
        Applied::Restore(_)
    ));
}
