//! 队列/会话前端保护：真实 stop 路径、paused 队列拒绝、TopicClosed 失效编辑与提交门禁。
use crate::{
    client::Client,
    frontend::{self, Frontend},
    frontend_test_support::{endpoints, key, next_request, reply, request},
    keyboard,
    projection::View,
    queue::QueueEdit,
    queue_test_support::{accepted, endpoints as queue_endpoints, item, queue_view},
    session,
};
use crossterm::event::KeyCode;
use serde_json::{Value, json};
use zcode_cli_core_api::{ClientMsg, RuntimeEvent, ServerMsg};

fn idle_view(items: Value, auto_drain: bool) -> View {
    let mut view = View::default();
    view.snapshot(&json!({
        "sessionId":"s","seq":1,"logEpoch":"epoch-1","revision":7,
        "rows":{"window":[]},
        "control":{"phase":"idle","canStop":false,"activeWorks":[]},
        "config":{"mode":"build"},
        "availability":{"queueEdit":{"allowed":true},"sendQueuedNow":{"allowed":true}},
        "queue":{"items":items,"autoDrain":auto_drain},
        "pendingInteractions":[]
    }));
    view
}

#[tokio::test]
async fn stop_uses_the_real_control_active_works_id_not_a_root_lookalike() {
    let ((to, mut from), actor, recorded) = queue_endpoints(vec![accepted()]);
    let mut client = Client::new(&to, &mut from);
    let mut view = View {
        state: json!({
            "control": {"activeWorks": [
                {"kind":"primaryTurn","foregroundExecutionId":"exec-real"},
                {"kind":"compact","foregroundExecutionId":""}
            ]},
            // 旧错误路径曾读根级 activeWorks；它不能被当成真实快照。
            "activeWorks": {"foregroundExecutionId": "exec-fake-root"}
        }),
        ..View::default()
    };
    session::stop(&mut client, &mut view).await.unwrap();
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(
        recorded[0].1["payload"]["expectedForegroundExecutionId"],
        "exec-real"
    );
    actor.await.unwrap();
}

#[tokio::test]
async fn stop_without_a_real_foreground_id_keeps_the_stale_run_guard() {
    let ((to, mut from), actor, recorded) = queue_endpoints(vec![accepted()]);
    let mut client = Client::new(&to, &mut from);
    let mut view = View {
        state: json!({
            "control": {"activeWorks": [{"kind":"compact","foregroundExecutionId":""}]},
            "activeWorks": {"foregroundExecutionId": "exec-fake-root"}
        }),
        ..View::default()
    };
    session::stop(&mut client, &mut view).await.unwrap();
    let recorded = recorded.lock().unwrap().clone();
    assert!(
        recorded[0].1["payload"]
            .get("expectedForegroundExecutionId")
            .is_none(),
        "没有真实 known id 时不得伪造：{:?}",
        recorded[0].1
    );
    actor.await.unwrap();
}

#[tokio::test]
async fn paused_queue_rejection_keeps_the_draft_and_names_the_real_exit() {
    let (to, mut requests, responses, mut from) = endpoints();
    let _ = &mut requests;
    let mut client = Client::new(&to, &mut from);
    let mut view = idle_view(json!([item("q1", "sendText", "held item")]), false);
    view.editor.insert("new prompt");
    let req = request();
    let reply_task = tokio::spawn(async move {
        reply(
            &responses,
            1,
            json!({"status":"rejected","reasonCode":"heldQueueDispositionRequired"}),
        )
        .await;
    });
    // 走真实 Enter 入口：拒绝后正文必须回到 editor。
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &req)
            .await
            .unwrap()
    );
    reply_task.await.unwrap();
    assert_eq!(view.editor.text(), "new prompt");
    assert!(!view.pending_submit);
    let notice = view.notices.last().expect("visible rejection");
    assert!(notice.contains("heldQueueDispositionRequired"), "{notice}");
    assert!(notice.contains("/queue resume"), "{notice}");
    assert!(notice.contains("/queue list"), "{notice}");
    assert!(requests.try_recv().is_ok(), "submit 已发送一次 sendText");
}

#[tokio::test]
async fn held_queue_sendtext_never_auto_sets_a_disposition() {
    let ((to, mut from), actor, recorded) = queue_endpoints(vec![json!({
        "status":"rejected","reasonCode":"heldQueueDispositionRequired"
    })]);
    let mut client = Client::new(&to, &mut from);
    let mut view = idle_view(json!([item("q1", "sendText", "held item")]), false);
    let error = session::submit(&mut client, &mut view, &request(), "draft")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("heldQueueDispositionRequired"), "{error}");
    assert!(!view.pending_submit);
    let recorded = recorded.lock().unwrap().clone();
    let payload = &recorded[0].1["payload"];
    assert!(payload.get("heldQueueDisposition").is_none(), "{payload:?}");
    assert!(payload.get("expectedHeldQueueItemIds").is_none());
    assert_eq!(payload["text"], "draft");
    actor.await.unwrap();
}

#[tokio::test]
async fn other_rejections_still_show_the_original_reason_code() {
    let ((to, mut from), actor, _recorded) = queue_endpoints(vec![json!({
        "status":"rejected","reasonCode":"guard.modelUnavailable"
    })]);
    let mut client = Client::new(&to, &mut from);
    let mut view = idle_view(json!([]), true);
    let error = session::submit(&mut client, &mut view, &request(), "draft")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("guard.modelUnavailable"), "{error}");
    actor.await.unwrap();
}

#[tokio::test]
async fn topic_closed_keeps_the_edit_buffer_consumes_keys_and_blocks_main_submit() {
    let (to, mut requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = queue_view(json!([item("q1", "sendText", "queued text")]), false);
    let queued = item("q1", "sendText", "queued text");
    view.queue_edit = Some(QueueEdit::from_item(&view, &queued, 7, "epoch-1"));
    let req = request();
    let mut frontend = Frontend::default();
    frontend.after_change(&mut view);

    // 同 id generation 推进 = 真实 TopicClosed（必须由事件断言，不能手工改世代冒充）。
    client
        .observe(
            &mut view,
            ServerMsg::Event(RuntimeEvent::TopicClosed {
                topic: "conversation/s".into(),
            }),
        )
        .await
        .unwrap();
    frontend.after_change(&mut view);
    assert!(view.topic_closed);
    assert_eq!(view.queue_edit.as_ref().unwrap().text(), "queued text");

    // Enter/普通键都不能落到主 editor 或发送旧草稿。
    for code in [KeyCode::Enter, KeyCode::Char('x')] {
        let quit = keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(code),
            false,
        )
        .await
        .unwrap();
        assert!(!quit);
    }
    assert!(requests.try_recv().is_err(), "stale edit must not submit");
    assert_eq!(view.queue_edit.as_ref().unwrap().text(), "queued text");
    assert!(view.editor.text().is_empty());
    assert!(
        view.notices
            .iter()
            .any(|n| n.contains("old generation") || n.contains("旧世代"))
    );

    // Esc 才取消失效缓冲；随后普通 Enter 仍被 TopicClosed 本地拒绝。
    assert!(
        !keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Esc),
            false
        )
        .await
        .unwrap()
    );
    assert!(view.queue_edit.is_none());
    view.editor.replace_all("after close");
    assert!(
        !keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Enter),
            false
        )
        .await
        .unwrap()
    );
    assert_eq!(view.editor.text(), "after close");
    assert!(
        requests.try_recv().is_err(),
        "closed session must not submit"
    );
    assert!(view.notices.last().is_some_and(|n| n.contains("/new")));
}

#[tokio::test]
async fn resumed_same_session_stays_open_for_normal_input_after_a_later_change() {
    // 回归：同 id resume 走 mem::take + snapshot 必然推进 generation；after_change 不能
    // 把它当成 TopicClosed，否则恢复后的正常输入被永久本地拒绕。
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = idle_view(json!([]), true);
    let req = request();
    let mut frontend = Frontend::default();
    // 前端已收敛到 s/gen1。
    frontend.after_change(&mut view);
    let actor = tokio::spawn(async move {
        let (token, method, params) = next_request(&mut requests).await;
        assert_eq!(method, "session/resume");
        assert_eq!(params["sessionId"], "s");
        reply(
            &responses,
            token,
            json!({"session":{"sessionId":"s"},"settings":{}}),
        )
        .await;
        let (token, method, _) = next_request(&mut requests).await;
        assert_eq!(method, "internal/topicOpen");
        reply(
            &responses,
            token,
            json!({"snapshot":{"sessionId":"s","seq":0,"rows":{"window":[]},
                "control":{"phase":"idle","canStop":false,"activeWorks":[]},
                "config":{"mode":"build"},"pendingInteractions":[]}}),
        )
        .await;
        // 恢复后的普通 Enter 必须真的提交。
        let (token, method, params) = next_request(&mut requests).await;
        assert_eq!(method, "v4/command");
        assert_eq!(params["type"], "sendText");
        assert_eq!(params["payload"]["text"], "hello");
        reply(&responses, token, json!({"status":"accepted"})).await;
    });
    view.editor.replace_all("/resume s");
    assert!(
        !keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Enter),
            false
        )
        .await
        .unwrap()
    );
    assert_eq!(view.session, "s");
    // 主循环每个 tick/键后都会收敛本地草稿，这里必须保持解除状态。
    frontend.after_change(&mut view);
    assert!(!view.topic_closed);
    view.editor.replace_all("hello");
    assert!(
        !keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Enter),
            false
        )
        .await
        .unwrap()
    );
    actor.await.unwrap();
    assert_eq!(view.editor.text(), "");
    assert!(!view.topic_closed);
}

#[tokio::test]
async fn successful_new_open_clears_the_closed_gate() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = idle_view(json!([]), true);
    view.topic_closed = true;
    view.editor.insert("/new");
    let req = request();
    let mut frontend = Frontend::default();
    frontend.after_change(&mut view);
    let actor = tokio::spawn(async move {
        let (token, method, _) = next_request(&mut requests).await;
        assert_eq!(method, "session/create");
        reply(&responses, token, json!({"session":{"sessionId":"s2"}})).await;
        let (token, method, _) = next_request(&mut requests).await;
        assert_eq!(method, "internal/topicOpen");
        reply(
            &responses,
            token,
            json!({"snapshot":{"sessionId":"s2","seq":0,"rows":{"window":[]},
                "control":{"phase":"idle","canStop":false,"activeWorks":[]},
                "config":{"mode":"build"},"pendingInteractions":[]}}),
        )
        .await;
        assert!(matches!(
            requests.recv().await,
            Some(ClientMsg::TopicReleased { .. })
        ));
    });
    assert!(
        !keyboard::handle(
            &mut frontend,
            &mut client,
            &mut view,
            &req,
            key(KeyCode::Enter),
            false
        )
        .await
        .unwrap()
    );
    actor.await.unwrap();
    assert_eq!(view.session, "s2");
    assert!(!view.topic_closed);
}
