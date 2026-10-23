//! 队列命令与真实 v4 schema / 快照辅助的契约回归。
use crate::{client::Client, queue, queue_state, queue_state::QueueOp, queue_test_support::*};
use serde_json::json;

#[test]
fn queue_payloads_survive_the_real_protocol_parser() {
    for (kind, payload) in [
        ("deleteQueueItem", json!({"queueItemId":"q1"})),
        ("sendQueuedNow", json!({"queueItemId":"q1"})),
        (
            "reorderQueueItem",
            json!({"queueItemId":"q1","beforeQueueItemId":null}),
        ),
        ("setAutoDrain", json!({"autoDrain":false})),
        (
            "editQueueItem",
            json!({"queueItemId":"q1","newText":"keep  inner\nlines"}),
        ),
    ] {
        let command = queue::cas("s", kind, payload.clone(), 3, "epoch-9");
        let parsed = zcode_cli_protocol::parse_command(&command).expect("canonical queue command");
        assert_eq!(parsed.kind, kind);
        assert_eq!(
            parsed.payload, payload,
            "{kind} payload must not be stripped"
        );
        assert_eq!(parsed.base_revision, Some(3.0));
    }
    // 缺少 CAS 基线时真实 schema 直接拒绝（不静默补 0）。
    let mut missing = queue::cas(
        "s",
        "deleteQueueItem",
        json!({"queueItemId":"q1"}),
        0,
        "epoch-9",
    );
    missing.as_object_mut().unwrap().remove("baseRevision");
    let error = zcode_cli_protocol::parse_command(&missing).unwrap_err();
    assert!(error.starts_with("baseRevision:"), "{error}");
}

#[test]
fn queue_state_helpers_are_id_based() {
    let view = queue_view(
        json!([item("q1", "sendText", "a"), item("q2", "sendText", "b")]),
        false,
    );
    assert_eq!(queue_state::items(&view).len(), 2);
    assert_eq!(queue_state::find(&view, "q2").unwrap()["text"], "b");
    assert!(queue_state::find(&view, "q3").is_none());
    assert_eq!(queue_state::revision(&view), 7);
    assert_eq!(queue_state::log_epoch(&view), "epoch-1");
    assert!(!queue_state::auto_drain(&view));
}

#[tokio::test]
async fn queue_menu_and_mutations_work_while_the_turn_is_busy() {
    // picker::confirm 的 busy 门禁不得挡住队列操作：运行中才需要删除/提升排队项。
    let mut view = queue_view(json!([item("q1", "sendText", "a")]), false);
    view.state["control"]["canStop"] = true.into();
    assert!(view.busy());
    let ((to, mut from), actor, recorded) = endpoints(vec![accepted(), snapshot_reply(json!([]))]);
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, &mut view, "/queue")
        .await
        .unwrap();
    // 第一步选 queue 项（busy 也不被 picker 的 busy 门禁挡住），再选删除操作。
    crate::picker::confirm(&mut client, &mut view, &crate::projection_tests::request())
        .await
        .unwrap();
    let mut selector = view.selector.take().expect("queue menu");
    assert!(select(&mut selector, QueueOp::Delete));
    view.selector = Some(selector);
    crate::picker::confirm(&mut client, &mut view, &crate::projection_tests::request())
        .await
        .unwrap();
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded[0].1["type"], "deleteQueueItem");
    assert!(view.selector.is_none());
    actor.await.unwrap();
}

#[test]
fn only_exact_queue_token_is_owned() {
    assert!(queue::handles("/queue"));
    assert!(queue::handles("  /queue delete q1 "));
    assert!(!queue::handles("/queuefoo"));
    assert!(!queue::handles("/queues list"));
    assert!(!queue::handles("hello /queue"));
    assert!(!queue::handles("/help"));
}

#[test]
fn empty_actor_queue_is_a_local_error_not_a_fake_menu() {
    let view = queue_view(json!([]), true);
    let error = queue::open(&view).unwrap_err().to_string();
    assert!(error.contains("queue is empty"), "{error}");
}

/// stale ACK 必须带出 actor 自己的 reasonCode，不能换成本地笼统提示。
#[tokio::test]
async fn stale_ack_keeps_the_actor_reason_code() {
    let mut view = queue_view(json!([item("q1", "sendText", "a")]), true);
    let ((to, mut from), actor, _recorded) = endpoints(vec![json!({
        "status":"stale",
        "reasonCode":"queue.revisionMismatch"
    })]);
    let mut client = Client::new(&to, &mut from);
    let error = queue::dispatch(&mut client, &mut view, "/queue delete q1")
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("queue.revisionMismatch"),
        "stale must keep the actor reasonCode: {error}"
    );
    actor.await.unwrap();
}

#[test]
fn cas_envelope_carries_the_captured_baseline() {
    let command = queue::cas(
        "s",
        "deleteQueueItem",
        json!({"queueItemId":"q1"}),
        7,
        "epoch-1",
    );
    assert_eq!(command["type"], "deleteQueueItem");
    assert_eq!(command["baseRevision"], 7);
    assert_eq!(command["baseLogEpoch"], "epoch-1");
}
