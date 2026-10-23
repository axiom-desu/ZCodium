//! 满通道 / 迟到回包下的 workflow 回归：staged 保序重试、所发版本结算、旧世代失效。
use crate::{
    client::Client,
    frontend::{self, Frontend},
    frontend_test_support::{endpoints, next_request, request, view},
    session,
};
use serde_json::json;
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, ServerMsg};

fn session_snapshot(id: &str) -> serde_json::Value {
    json!({"snapshot":{"sessionId":id,"seq":0,"rows":{"window":[]},"control":{"canStop":false},
        "config":{"mode":"build"},"pendingInteractions":[]}})
}

/// 一次 poll：结算所有已到达回包并发出续步，不阻塞。
async fn poll(client: &mut Client<'_>, view: &mut crate::projection::View) {
    Frontend::default().poll(client, view).await.unwrap();
}

async fn observe(client: &mut Client<'_>, view: &mut crate::projection::View) {
    let message = client.next().await.unwrap();
    client.observe(view, message).await.unwrap();
}

async fn reply(responses: &mpsc::Sender<Vec<ServerMsg>>, token: u64, result: serde_json::Value) {
    responses
        .send(vec![ServerMsg::Reply {
            token,
            result: Ok(result),
        }])
        .await
        .unwrap();
}

#[tokio::test]
async fn full_channel_keeps_boot_staged_and_retries_in_order() {
    let (to, mut requests, responses, mut from) = endpoints();
    // 占满通道：boot 第一步发不出去，但 workflow 仍登记，主循环不会 await。
    for _ in 0..8 {
        to.try_send(ClientMsg::Eof).unwrap();
    }
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.session.clear();
    session::begin_open(
        &mut client,
        &mut view,
        &request(),
        crate::transport::Resume::New,
    )
    .unwrap();
    assert!(client.mutation_flow_busy());
    // 用户仍可编辑；随后通道腾空，下一轮 pump 按序补发。
    view.editor.insert("keep");
    while requests.try_recv().is_ok() {}
    poll(&mut client, &mut view).await;
    let (token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "session/create");
    reply(
        &responses,
        token,
        json!({"session":{"sessionId":"s2"},"settings":{}}),
    )
    .await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    assert_eq!(view.editor.text(), "keep");
}

#[tokio::test]
async fn queue_edit_ack_settles_only_the_sent_version_and_keeps_later_typing() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.state = json!({"queue":{"items":[{"queueItemId":"q1","kind":"sendText","text":"old"}],
        "autoDrain":false},"revision":3,"logEpoch":"e1"});
    let item = view.state["queue"]["items"][0].clone();
    let choice = crate::queue::QueueChoice {
        queue_item_id: "q1".into(),
        op: Some(crate::queue::QueueOp::Edit),
        revision: 3,
        log_epoch: "e1".into(),
    };
    crate::queue::start_edit(&mut view, &item, &choice).unwrap();
    // 用户继续输入：所发版本与新版本不同。
    if let Some(edit) = view.queue_edit.as_mut() {
        edit.editor.insert(" +more");
    }
    let sent = crate::flow_queue::SentEdit {
        queue_item_id: "q1".into(),
        revision: 3,
        log_epoch: "e1".into(),
        text: "old".into(),
        raw_editor_text: "old".into(),
        generation: view.generation,
    };
    crate::queue::begin_mutate(
        &mut client,
        &mut view,
        "editQueueItem",
        json!({"queueItemId":"q1","newText":"old"}),
        3,
        "e1",
        crate::queue::Settle {
            edit: Some(sent),
            close_selector: false,
        },
    )
    .unwrap();
    let (token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "v4/command");
    reply(&responses, token, json!({"status":"accepted"})).await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    // 迟到的 accepted 不能清掉保存之后继续输入的内容。
    assert!(view.queue_edit.is_some(), "后续输入必须保留");
    let (snap_token, _, _) = next_request(&mut requests).await;
    reply(&responses, snap_token, session_snapshot("s")).await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
}

#[tokio::test]
async fn queue_stale_keeps_the_local_edit_and_the_actor_reason() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.state = json!({"queue":{"items":[{"queueItemId":"q1","kind":"sendText","text":"old"}],
        "autoDrain":false},"revision":3,"logEpoch":"e1"});
    let item = view.state["queue"]["items"][0].clone();
    let choice = crate::queue::QueueChoice {
        queue_item_id: "q1".into(),
        op: Some(crate::queue::QueueOp::Edit),
        revision: 3,
        log_epoch: "e1".into(),
    };
    crate::queue::start_edit(&mut view, &item, &choice).unwrap();
    let sent = crate::flow_queue::SentEdit {
        queue_item_id: "q1".into(),
        revision: 3,
        log_epoch: "e1".into(),
        text: "old".into(),
        raw_editor_text: "old".into(),
        generation: view.generation,
    };
    crate::queue::begin_mutate(
        &mut client,
        &mut view,
        "editQueueItem",
        json!({"queueItemId":"q1","newText":"old"}),
        3,
        "e1",
        crate::queue::Settle {
            edit: Some(sent),
            close_selector: false,
        },
    )
    .unwrap();
    let (token, _, _) = next_request(&mut requests).await;
    reply(
        &responses,
        token,
        json!({"status":"stale","reasonCode":"queue.revisionMismatch"}),
    )
    .await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    assert!(view.queue_edit.is_some(), "拒绝必须保留原草稿");
    assert!(
        view.notices
            .last()
            .is_some_and(|note| note.contains("queue.revisionMismatch")),
        "{:?}",
        view.notices.last()
    );
}

#[tokio::test]
async fn late_draft_ack_does_not_settle_a_newer_generation() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("hello");
    view.sync_completion();
    frontend::submit_editor(&mut client, &mut view, &request())
        .await
        .unwrap();
    let (token, _, _) = next_request(&mut requests).await;
    // 世代推进（TopicClosed/同 id 重开）后旧 ACK 才到。
    view.generation = view.generation.wrapping_add(1);
    view.operations.invalidate(view.generation);
    client.pump_flows(&mut view).unwrap();
    reply(&responses, token, json!({"status":"accepted"})).await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    assert!(!view.pending_submit);
}

#[tokio::test]
async fn full_channel_submit_is_rejected_locally_with_the_draft_kept() {
    let (to, _requests, _responses, mut from) = endpoints();
    for _ in 0..8 {
        to.try_send(ClientMsg::Eof).unwrap();
    }
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("keep me");
    view.sync_completion();
    frontend::submit_editor(&mut client, &mut view, &request())
        .await
        .unwrap();
    assert_eq!(view.editor.text(), "keep me");
    assert!(!client.flow_busy());
}

#[tokio::test]
async fn full_channel_keeps_setting_staged_and_retries_in_order() {
    let (to, mut requests, _responses, mut from) = endpoints();
    for _ in 0..8 {
        to.try_send(ClientMsg::Eof).unwrap();
    }
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    session::begin_setting(
        &mut client,
        &mut view,
        zcode_cli_core_api::Method::SessionSetMode,
        json!({"sessionId":"s","mode":"plan"}),
    )
    .unwrap();
    assert!(
        client.mutation_flow_busy(),
        "workflow 已登记，草稿/意图不丢"
    );
    while requests.try_recv().is_ok() {}
    poll(&mut client, &mut view).await;
    let (_token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "session/setMode");
    assert_eq!(params["mode"], "plan");
}
