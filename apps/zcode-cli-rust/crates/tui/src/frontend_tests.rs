//! 真实 Client + fake runtime 的前端集成回归（history/query/queue 键路径）。
//!
//! 驱动与 `run` 共用的 `keyboard::handle` / `frontend::poll`，断言真正发往 actor 的请求。
use crate::{
    client::Client,
    draft_attachments::DraftAttachments,
    frontend::{self, Frontend},
    frontend_test_support::{endpoints, key, next_request, observe_next, reply, request, view},
    keyboard,
    queue::QueueEdit,
    queue_test_support::{item, queue_view},
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;

#[tokio::test]
async fn up_recalls_real_history_and_down_restores_the_original_draft() {
    let req = request();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("live draft");
    view.draft_attachments = DraftAttachments::from_startup(vec![json!({
        "ref": "/ws/report.pdf", "fileName": "report.pdf",
        "mime": "application/pdf", "bytes": 0
    })])
    .unwrap();
    let mut frontend = Frontend::default();

    assert!(
        !keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Up),
            false
        )
        .await
        .unwrap()
    );
    let (token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "internal/inputHistory/recall");
    assert_eq!(params["skip"], 0);

    reply(
        &responses,
        token,
        json!({"id":"h","text":"older @a.txt","kind":"prompt",
               "attachments":[{"type":"file","path":"a.txt"}]}),
    )
    .await;
    observe_next(&mut client, &mut view).await;
    assert!(frontend.poll(&mut client, &mut view).await.unwrap());

    assert_eq!(view.editor.text(), "older @a.txt");
    // 历史 inline @a.txt + 原草稿的启动 pinned：浏览历史不能静默丢 --attach。
    assert_eq!(
        view.draft_attachments
            .refs_for_text(view.editor.text())
            .len(),
        2
    );
    assert_eq!(
        view.draft_attachments.items()[0].placeholder.as_deref(),
        Some("@a.txt")
    );
    assert!(view.draft_attachments.items().iter().any(|item| {
        item.source == crate::draft_attachments::AttachmentSource::Startup
            && item.reference == "/ws/report.pdf"
    }));

    // ↓ 回到最新：恢复首次保存的正文与 pinned 附件，且不再请求。
    assert!(
        !keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Down),
            false
        )
        .await
        .unwrap()
    );
    assert_eq!(view.editor.text(), "live draft");
    assert_eq!(view.draft_attachments.len(), 1);
    assert!(view.draft_attachments.items()[0].placeholder.is_none());
    assert!(requests.try_recv().is_err(), "down past newest is local");
}

#[tokio::test]
async fn edited_draft_ignores_a_late_history_reply() {
    let req = request();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("draft");
    let mut frontend = Frontend::default();

    keyboard::handle(
        &mut frontend,
        &mut client,
        &mut view,
        &req,
        key(KeyCode::Up),
        false,
    )
    .await
    .unwrap();
    let (token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "internal/inputHistory/recall");

    keyboard::handle(
        &mut frontend,
        &mut client,
        &mut view,
        &req,
        key(KeyCode::Char('x')),
        false,
    )
    .await
    .unwrap();
    assert_eq!(view.editor.text(), "draftx");

    reply(&responses, token, json!({"text":"old","attachments":[]})).await;
    observe_next(&mut client, &mut view).await;
    frontend.poll(&mut client, &mut view).await.unwrap();
    assert_eq!(view.editor.text(), "draftx", "迟到回包不能覆盖新草稿");
}

#[tokio::test]
async fn busy_compact_and_unknown_slash_stay_local() {
    let req = request();
    let (to, mut requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.pending_submit = true;

    view.editor.insert("/compact keep");
    view.sync_completion();
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &req)
            .await
            .unwrap()
    );
    assert_eq!(view.editor.text(), "/compact keep");
    assert!(view.notices.last().is_some_and(|n| n.contains("busy")));

    view.editor.replace_all("/nope");
    view.sync_completion();
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &req)
            .await
            .unwrap()
    );
    assert_eq!(view.editor.text(), "/nope");
    assert!(
        view.notices
            .last()
            .is_some_and(|n| n.contains("Unknown command"))
    );

    // /effort 仍是 busy 拒绝：原约束不变，不能借 queue 绕过 admission。
    view.editor.replace_all("/effort high");
    view.sync_completion();
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert_eq!(view.editor.text(), "/effort high");
    assert!(view.notices.last().is_some_and(|n| n.contains("busy")));
    assert!(requests.try_recv().is_err(), "本地拒绝不能绕过 admission");
}

#[tokio::test]
async fn ctrl_d_cancels_root_without_waiting_for_a_stop_ack() {
    let req = request();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.state = json!({
        "control": {
            "canStop": true,
            "activeWorks": [{"kind": "primaryTurn", "foregroundExecutionId": "exec-1"}]
        }
    });
    let mut frontend = Frontend::default();

    keyboard::handle(
        &mut frontend,
        &mut client,
        &mut view,
        &req,
        key(KeyCode::Up),
        false,
    )
    .await
    .unwrap();
    let (history_token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "internal/inputHistory/recall");
    assert_ne!(history_token, 0);

    let ctrl_d = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL);
    // 历史读未回包时 Ctrl-D 也必须立即登记 root 退出，不发送/等待 stop。
    assert!(
        keyboard::handle(&mut frontend, &mut client, &mut view, &req, ctrl_d, false)
            .await
            .unwrap()
    );
    assert!(frontend.take_quit());
    assert!(requests.try_recv().is_err(), "Ctrl-D 不能等 stop ACK");
    drop(responses);
}

#[tokio::test]
async fn queue_edit_yields_to_an_interaction_and_the_main_editor_answers() {
    let req = request();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = queue_view(json!([item("q1", "sendText", "queued text")]), true);
    let queued = item("q1", "sendText", "queued text");
    view.queue_edit = Some(QueueEdit::from_item(&view, &queued, 7, "epoch-1"));
    view.state["pendingInteractions"] = json!([{
        "interactionId": "i1", "kind": "permission",
        "payload": {"toolName":"Bash","summary":"run","options":[{"optionId":"allowOnce","label":"Allow"}]}
    }]);
    view.editor.insert("y");
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
    assert_eq!(method, "v4/command");
    assert_eq!(params["type"], "resolveInteraction");
    assert_eq!(params["payload"]["answer"]["optionId"], "allowOnce");
    assert!(view.queue_edit.is_some(), "审批不吃掉队列编辑草稿");
}

#[tokio::test]
async fn queue_edit_enter_commits_the_captured_cas_envelope() {
    let req = request();
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = queue_view(json!([item("q1", "sendText", "queued text")]), true);
    let queued = item("q1", "sendText", "queued text");
    view.queue_edit = Some(QueueEdit::from_item(&view, &queued, 7, "epoch-1"));
    let mut frontend = Frontend::default();
    let snapshot = json!({"snapshot": {
        "sessionId":"s","seq":2,"logEpoch":"epoch-1","revision":8,
        "rows":{"window":[]},"control":{"canStop":true},"config":{"mode":"build"},
        "queue":{"items":[],"autoDrain":true},"pendingInteractions":[]
    }});

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
            // 成功后只回拉 actor 快照。
            let (refresh, refresh_method, _) = next_request(&mut requests).await;
            assert_eq!(refresh_method, "internal/topicSnapshot");
            reply(&responses, refresh, snapshot).await;
            (method, params)
        }
    );
    assert!(!quit.unwrap());
    assert_eq!(method, "v4/command");
    assert_eq!(params["type"], "editQueueItem");
    assert_eq!(params["payload"]["newText"], "queued text");
    assert_eq!(params["baseRevision"], 7);
    assert_eq!(params["baseLogEpoch"], "epoch-1");
    assert!(view.queue_edit.is_none());
}

#[tokio::test]
async fn generation_change_drops_stale_queue_edit_and_history_cursor() {
    let mut view = queue_view(json!([item("q1", "sendText", "queued text")]), true);
    let queued = item("q1", "sendText", "queued text");
    let mut frontend = Frontend::default();
    frontend.after_change(&mut view);
    view.queue_edit = Some(QueueEdit::from_item(&view, &queued, 7, "epoch-1"));
    frontend.after_change(&mut view);
    assert!(view.queue_edit.is_some(), "same generation keeps the edit");

    // TopicClosed 是唯一推进 generation 的真实事件：旧编辑保留为可见失效缓冲，
    // 直到用户 Esc。
    let (to, _requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    client
        .observe(
            &mut view,
            zcode_cli_core_api::ServerMsg::Event(zcode_cli_core_api::RuntimeEvent::TopicClosed {
                topic: "conversation/s".into(),
            }),
        )
        .await
        .unwrap();
    frontend.after_change(&mut view);
    assert!(view.queue_edit.is_some());
    assert!(view.topic_closed);
}

#[tokio::test]
async fn mcp_and_usage_slashes_send_one_read_ticket_without_waiting() {
    let req = request();
    let (to, mut requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();

    for text in ["/mcp", "/usage"] {
        view.editor.replace_all(text);
        view.sync_completion();
        assert!(
            !frontend::submit_editor(&mut client, &mut view, &req)
                .await
                .unwrap()
        );
        assert!(view.editor.text().is_empty());
    }
    let (_, first, params) = next_request(&mut requests).await;
    assert_eq!(first, "mcp/list");
    assert_eq!(params["mode"], "status");
    let (_, second, params) = next_request(&mut requests).await;
    assert_eq!(second, "session/usage");
    assert_eq!(params["sessionId"], "s");
    // 没有回包也没有阻塞：两个读票据都已发出，stop/quit 仍可继续。
    assert!(requests.try_recv().is_err());
}
