//! 慢 ACK 下的真实异步 submit/stop 回归：发送即返回、编辑继续、回包只由 poll 结算。
use crate::{
    client::Client,
    frontend::{self, Frontend},
    frontend_test_support::{
        complete, endpoints, next_request, observe_next, reply, request, view,
    },
    keyboard, queue,
    queue_test_support::{accepted, item, queue_view, snapshot_reply},
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;
use zcode_cli_core_api::{RuntimeEvent, ServerMsg};

#[tokio::test]
async fn submit_returns_to_the_loop_and_a_late_ack_never_clears_new_typing() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("first");
    view.sync_completion();

    // fake actor 不回包：submit 仍必须立即返回主循环。
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert!(view.operations.busy());
    assert!(view.pending_submit);
    assert!(view.editor.text().is_empty());

    // 等待 ACK 期间继续输入下一条；旧 ACK 只能结算已发送那份。
    view.editor.insert("next draft");
    let (token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "v4/command");
    assert_eq!(params["type"], "sendText");
    assert_eq!(params["payload"]["text"], "first");
    reply(&responses, token, json!({"status":"accepted"})).await;

    complete(&mut client, &mut view).await;
    assert_eq!(view.editor.text(), "next draft");
    assert!(!view.pending_submit);
    assert!(!view.operations.busy());
    assert!(requests.try_recv().is_err(), "旧 ACK 不能重发或清空新草稿");
}

#[tokio::test]
async fn ctrl_c_shows_intent_and_sends_one_stop_only_after_the_slot_settles() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.state = json!({
        "control": {"activeWorks": [{"foregroundExecutionId": "exec-1"}]}
    });
    view.editor.insert("running");
    view.sync_completion();
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let (submit_token, _, _) = next_request(&mut requests).await;

    let ctrl_c = KeyEvent::new(crossterm::event::KeyCode::Char('c'), KeyModifiers::CONTROL);
    assert!(
        !keyboard::handle(
            &mut Frontend::default(),
            &mut client,
            &mut view,
            &request(),
            ctrl_c,
            false
        )
        .await
        .unwrap()
    );
    assert!(view.operations.stop_pending());
    assert!(requests.try_recv().is_err(), "slot 忙时不能并发 stop");

    reply(&responses, submit_token, json!({"status":"accepted"})).await;
    complete(&mut client, &mut view).await;
    let (stop_token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "v4/command");
    assert_eq!(params["type"], "stop");
    assert_eq!(params["payload"]["expectedForegroundExecutionId"], "exec-1");

    reply(&responses, stop_token, json!({"status":"accepted"})).await;
    complete(&mut client, &mut view).await;
    assert!(!view.operations.stop_pending());
}

#[tokio::test]
async fn channel_full_restores_the_sent_draft_instead_of_faking_success() {
    let (to, mut requests, _responses, mut from) = endpoints();
    // 占满通道，模拟高负载/慢 consumer。
    for _ in 0..8 {
        to.try_send(zcode_cli_core_api::ClientMsg::Eof).unwrap();
    }
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("keep me");
    view.sync_completion();

    assert!(
        !frontend::submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert_eq!(view.editor.text(), "keep me");
    assert!(!view.pending_submit);
    assert!(!view.operations.busy());
    assert!(requests.try_recv().is_ok(), "只有测试自身占位的 Eof");
    assert!(
        view.notices
            .last()
            .is_some_and(|notice| notice.contains("busy") || notice.contains("繁忙")),
        "{:?}",
        view.notices.last()
    );
}

/// 提交等待 ACK 时发起队列 mutation：必须被全局门禁拒绝，保留斜杠草稿，不产生第二请求。
#[tokio::test]
async fn queue_mutation_is_refused_while_a_submit_waits_for_admission() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = queue_view(json!([item("q1", "sendText", "queued")]), false);
    view.editor.insert("first");
    view.sync_completion();
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let (token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "v4/command");
    view.editor.replace_all("/queue pause");
    view.sync_completion();
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert_eq!(view.editor.text(), "/queue pause", "队列选择器/草稿保持");
    assert!(view.operations.busy(), "原 submit 仍是唯一 mutation");
    assert!(
        requests.try_recv().is_err(),
        "draft 在飞时 /queue 不能发第二 mutation"
    );
    reply(&responses, token, json!({"status":"accepted"})).await;
    complete(&mut client, &mut view).await;
    assert!(!view.operations.busy());
}

/// 同会话 resync/ConversationReset 与 control patch 不能清待 ACK overlay 或跳走滚动位置。
#[tokio::test]
async fn resync_snapshot_keeps_pending_overlay_and_user_scroll() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("first");
    view.sync_completion();
    assert!(
        !frontend::submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let (token, _, _) = next_request(&mut requests).await;
    view.follow = false;
    view.scroll = 9;
    let snapshot = json!({"sessionId":"s","seq":1,"rows":{"window":[]},
        "control":{"phase":"running","canStop":true},"config":{"mode":"build"},
        "pendingInteractions":[]});
    client
        .observe(
            &mut view,
            ServerMsg::Event(RuntimeEvent::ConversationReset {
                session: "s".into(),
                seq: 1,
                snapshot,
            }),
        )
        .await
        .unwrap();
    assert!(view.pending_submit, "未 ACK overlay 不能被快照清掉");
    assert!(!view.follow);
    assert_eq!(view.scroll, 9);
    view.deltas(
        "s",
        1,
        2,
        std::iter::once(json!({"op":"state.updated","patch":{"control":{"canStop":true}}})),
    );
    assert!(view.pending_submit, "control 事实也不能清真实在飞 draft");
    reply(&responses, token, json!({"status":"accepted"})).await;
    complete(&mut client, &mut view).await;
    assert!(!view.pending_submit);
}

/// 队列 workflow 等 ACK 时 Ctrl-C：只合并一份 stop 意图，等 flow 结算后再发。
#[tokio::test]
async fn ctrl_c_during_queue_ack_merges_stop_instead_of_a_second_mutation() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = queue_view(json!([item("q1", "sendText", "queued")]), false);
    view.state["control"]["canStop"] = true.into();
    queue::begin_mutate(
        &mut client,
        &mut view,
        "setAutoDrain",
        json!({"autoDrain":false}),
        7,
        "epoch-1",
        queue::Settle::default(),
    )
    .unwrap();
    let (queue_token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "v4/command");
    assert_eq!(params["type"], "setAutoDrain");
    let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
    keyboard::handle(
        &mut Frontend::default(),
        &mut client,
        &mut view,
        &request(),
        ctrl_c,
        false,
    )
    .await
    .unwrap();
    assert!(view.operations.stop_pending());
    assert!(requests.try_recv().is_err(), "flow 在飞时不能并发 stop");
    reply(&responses, queue_token, accepted()).await;
    observe_next(&mut client, &mut view).await;
    Frontend::default()
        .poll(&mut client, &mut view)
        .await
        .unwrap();
    let (snapshot_token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "internal/topicSnapshot");
    reply(&responses, snapshot_token, snapshot_reply(json!([]))).await;
    observe_next(&mut client, &mut view).await;
    Frontend::default()
        .poll(&mut client, &mut view)
        .await
        .unwrap();
    let (stop_token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "v4/command");
    assert_eq!(params["type"], "stop");
    reply(&responses, stop_token, accepted()).await;
    complete(&mut client, &mut view).await;
    assert!(!view.operations.stop_pending());
}
