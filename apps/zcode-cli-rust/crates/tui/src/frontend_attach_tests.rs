//! 附件与 busy 提交的集成回归（draft refs / 拒绝保留 / @file 两次 Enter）。
use crate::{
    client::Client,
    frontend::{self, Frontend},
    frontend_test_support::{
        complete, draft_with, endpoints, key, next_request, reply, request, view,
    },
    keyboard,
};
use crossterm::event::KeyCode;
use serde_json::json;

#[tokio::test]
async fn busy_plain_text_is_enqueued_with_draft_attachments() {
    let req = request();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.pending_submit = true;
    view.draft_attachments = draft_with("a.txt", 4);
    view.editor.insert("@a.txt hello");
    view.sync_completion();
    let mut frontend = Frontend::default();

    let (quit, (method, params)) = tokio::join!(
        keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Enter),
            false
        ),
        async {
            let (token, method, params) = next_request(&mut requests).await;
            reply(&responses, token, json!({"status":"accepted"})).await;
            (method, params)
        }
    );
    assert!(!quit.unwrap());
    complete(&mut client, &mut view).await;
    assert_eq!(method, "v4/command");
    assert_eq!(params["type"], "sendText");
    assert_eq!(params["payload"]["text"], "@a.txt hello");
    assert_eq!(params["payload"]["requestedDelivery"], "queue");
    assert_eq!(params["payload"]["attachments"][0]["ref"], "a.txt");
    assert!(view.editor.text().is_empty());
    assert!(
        view.draft_attachments.is_empty(),
        "accepted send clears draft"
    );
}

#[tokio::test]
async fn rejected_send_keeps_text_and_attachments() {
    let req = request();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.draft_attachments = draft_with("a.txt", 4);
    view.editor.insert("@a.txt hi");
    view.sync_completion();

    let (result, params) = tokio::join!(
        frontend::submit_editor(&mut client, &mut view, &req),
        async {
            let (token, method, params) = next_request(&mut requests).await;
            assert_eq!(method, "v4/command");
            reply(
                &responses,
                token,
                json!({"status":"rejected","message":"owner moved"}),
            )
            .await;
            params
        }
    );
    assert!(!result.unwrap());
    complete(&mut client, &mut view).await;
    assert_eq!(params["payload"]["attachments"][0]["ref"], "a.txt");
    assert_eq!(view.editor.text(), "@a.txt hi");
    assert_eq!(
        view.draft_attachments.refs_for_text("@a.txt hi").len(),
        1,
        "拒绝后不能丢附件"
    );
    assert!(
        view.notices
            .last()
            .is_some_and(|n| n.contains("owner moved"))
    );
}

#[tokio::test]
async fn file_mention_accept_consumes_enter_and_the_next_enter_sends() {
    let req = request();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.directory = dir.path().to_string_lossy().into_owned();
    view.editor.insert("@a");
    let mut frontend = Frontend::default();
    frontend.after_change(&mut view);

    for _ in 0..200 {
        if view.file_mentions.poll() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(view.file_mentions.visible());
    assert!(!view.file_mentions.items().is_empty());

    // 第一次 Enter/Tab 只补全，不发 prompt。
    assert!(
        !keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Tab),
            false
        )
        .await
        .unwrap()
    );
    assert_eq!(view.editor.text(), "@a.txt ");
    assert_eq!(view.draft_attachments.len(), 1);
    assert!(requests.try_recv().is_err());
    frontend.after_change(&mut view);

    let (quit, params) = tokio::join!(
        keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Enter),
            false
        ),
        async {
            let (token, method, params) = next_request(&mut requests).await;
            assert_eq!(method, "v4/command");
            reply(&responses, token, json!({"status":"accepted"})).await;
            params
        }
    );
    assert!(!quit.unwrap());
    complete(&mut client, &mut view).await;
    assert_eq!(params["type"], "sendText");
    assert_eq!(params["payload"]["text"], "@a.txt ");
    assert_eq!(params["payload"]["attachments"][0]["ref"], "a.txt");
}
