//! 队列命令的 fake-actor 回归：精确 kind/payload/CAS、拒绝保留与真实 schema。
use crate::{client::Client, queue, queue_state::QueueOp, queue_test_support::*, selector::Choice};
use crossterm::event::KeyCode;
use serde_json::json;
use zcode_cli_core_api::Method;

#[tokio::test]
async fn typed_queue_menu_opens_the_operation_menu_and_a_local_edit_draft() {
    let ((to, mut from), actor, recorded) = endpoints(Vec::new());
    let mut client = Client::new(&to, &mut from);
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    assert!(
        queue::dispatch(&mut client, &mut view, "/queue")
            .await
            .unwrap()
    );
    let selector = view.selector.as_ref().unwrap();
    assert_eq!(selector.options.len(), 1);
    let Choice::Queue(choice) = selector.choice().unwrap().0.clone() else {
        panic!("queue selector must carry typed ids")
    };
    // typed id + 捕获的 CAS 基线，不是过滤行号。
    assert_eq!(choice.queue_item_id, "q1");
    assert_eq!(choice.revision, 7);
    assert_eq!(choice.log_epoch, "epoch-1");
    assert!(choice.op.is_none());

    // 第一步确认只换成操作菜单，不提交。
    queue::confirm(&mut client, &mut view).await.unwrap();
    let mut selector = view.selector.take().expect("operation menu");
    assert!(select(&mut selector, QueueOp::Edit));
    view.selector = Some(selector);
    queue::confirm(&mut client, &mut view).await.unwrap();

    assert!(view.selector.is_none());
    let edit = view.queue_edit.as_ref().expect("local edit draft");
    assert_eq!(edit.queue_item_id, "q1");
    assert_eq!(edit.text(), "hello");
    assert_eq!(edit.revision, 7);
    assert_eq!(edit.generation, view.generation);
    // main editor 保持干净：它专门用于回答异步权限/问答。
    assert!(view.editor.text().is_empty());
    assert!(
        recorded.lock().unwrap().is_empty(),
        "edit draft is local only"
    );
    actor.await.unwrap();
}

#[tokio::test]
async fn stale_ack_is_reported_without_retry_or_refresh() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let ((to, mut from), actor, recorded) = endpoints(vec![
        json!({"status":"stale","reasonCode":"proto.staleRevision"}),
    ]);
    let mut client = Client::new(&to, &mut from);
    let error = queue::dispatch(&mut client, &mut view, "/queue delete q1")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("stale"), "{error}");
    let recorded = recorded.lock().unwrap().clone();
    // 只有一次 command，没有自动重试、也没有回拉快照。
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].1["type"], "deleteQueueItem");
    assert_eq!(recorded[0].1["baseRevision"], 7);
    actor.await.unwrap();
}

#[tokio::test]
async fn accepted_edit_refreshes_from_the_actor_and_clears_the_local_draft() {
    let mut view = queue_view(json!([item("q1", "sendText", "hello")]), false);
    let ((to, mut from), actor, recorded) = endpoints(vec![
        accepted(),
        snapshot_reply(json!([item("q2", "sendText", "other")])),
    ]);
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap();
    assert!(
        queue::handle_key(&mut client, &mut view, key(KeyCode::Enter))
            .await
            .unwrap()
    );
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[1].0, Method::TopicSnapshot.as_str());
    assert!(view.queue_edit.is_none());
    // 队列内容只来自 actor 快照：本地没有凭空删除/保留项。
    assert_eq!(view.state["revision"], 8);
    assert_eq!(view.state["queue"]["items"][0]["queueItemId"], "q2");
    assert_eq!(view.state["queue"]["autoDrain"], true);
    actor.await.unwrap();
}

#[tokio::test]
async fn delete_send_reorder_and_autodrain_use_the_shared_cas_command() {
    // 单队列：delete 只看 typed id。
    let mut view = queue_view(json!([item("q1", "sendText", "a")]), false);
    let recorded = run(
        &mut view,
        "/queue delete q1",
        vec![accepted(), snapshot_reply(json!([]))],
    )
    .await;
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded[0].1["type"], "deleteQueueItem");
    assert_eq!(recorded[0].1["payload"], json!({"queueItemId":"q1"}));
    assert_eq!(recorded[0].1["baseRevision"], 7);
    assert_eq!(recorded[0].1["baseLogEpoch"], "epoch-1");
    assert_eq!(recorded[1].0, Method::TopicSnapshot.as_str());

    // sendNow 只提升指定 id，不 resume 整条队列。
    let mut view = queue_view(
        json!([item("q1", "sendText", "a"), item("q2", "sendText", "b")]),
        false,
    );
    let recorded = run(
        &mut view,
        "/queue send q2",
        vec![accepted(), snapshot_reply(json!([]))],
    )
    .await;
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded[0].1["type"], "sendQueuedNow");
    assert_eq!(recorded[0].1["payload"], json!({"queueItemId":"q2"}));

    // pause/resume 走 setAutoDrain 布尔值。
    let mut view = queue_view(json!([item("q1", "sendText", "a")]), true);
    let recorded = run(
        &mut view,
        "/queue pause",
        vec![accepted(), snapshot_reply(json!([]))],
    )
    .await;
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded[0].1["type"], "setAutoDrain");
    assert_eq!(recorded[0].1["payload"], json!({"autoDrain":false}));

    let mut view = queue_view(json!([item("q1", "sendText", "a")]), false);
    let recorded = run(
        &mut view,
        "/queue resume",
        vec![accepted(), snapshot_reply(json!([]))],
    )
    .await;
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded[0].1["type"], "setAutoDrain");
    assert_eq!(recorded[0].1["payload"], json!({"autoDrain":true}));
}

#[tokio::test]
async fn reorder_anchors_follow_current_neighbours_not_stale_indexes() {
    let items = json!([
        item("q1", "sendText", "a"),
        item("q2", "sendText", "b"),
        item("q3", "sendText", "c"),
        item("q4", "sendText", "d")
    ]);
    // 上移 q2 → 插到 q1 之前（相邻锚点，不是下标 0）。
    let mut view = queue_view(items.clone(), true);
    let recorded = run(
        &mut view,
        "/queue up q2",
        vec![accepted(), snapshot_reply(json!([]))],
    )
    .await;
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded[0].1["type"], "reorderQueueItem");
    assert_eq!(
        recorded[0].1["payload"],
        json!({"queueItemId":"q2","beforeQueueItemId":"q1"})
    );

    // 下移 q2 → 插到 q4 之前（= 越过 q3），锚点按当前快照的相邻项计算。
    let mut view = queue_view(items.clone(), true);
    let recorded = run(
        &mut view,
        "/queue down q2",
        vec![accepted(), snapshot_reply(json!([]))],
    )
    .await;
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(
        recorded[0].1["payload"],
        json!({"queueItemId":"q2","beforeQueueItemId":"q4"})
    );

    // 下移倒数第二项到队尾 → null（beforeQueueItemId 显式 null）。
    let mut view = queue_view(items.clone(), true);
    let recorded = run(
        &mut view,
        "/queue down q3",
        vec![accepted(), snapshot_reply(json!([]))],
    )
    .await;
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(
        recorded[0].1["payload"],
        json!({"queueItemId":"q3","beforeQueueItemId":null})
    );

    // 下移队尾项本来就是 noop：本地拒绝，不发模型。
    let mut view = queue_view(items.clone(), true);
    let ((to, mut from), actor, recorded) = endpoints(Vec::new());
    let mut client = Client::new(&to, &mut from);
    let error = queue::dispatch(&mut client, &mut view, "/queue down q4")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("already last"), "{error}");
    assert!(recorded.lock().unwrap().is_empty());
    actor.await.unwrap();

    // 上移队首项同理。
    let mut view = queue_view(items, true);
    let ((to, mut from), actor, recorded) = endpoints(Vec::new());
    let mut client = Client::new(&to, &mut from);
    assert!(
        queue::dispatch(&mut client, &mut view, "/queue up q1")
            .await
            .is_err()
    );
    assert!(recorded.lock().unwrap().is_empty());
    actor.await.unwrap();
}

#[tokio::test]
async fn removed_reserved_and_compact_targets_are_local_errors() {
    // id 已不存在：不按菜单位置猜 id，也不发请求。
    let mut view = queue_view(json!([item("q1", "sendText", "a")]), false);
    let ((to, mut from), actor, recorded) = endpoints(Vec::new());
    let mut client = Client::new(&to, &mut from);
    let error = queue::dispatch(&mut client, &mut view, "/queue delete q9")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("q9"), "{error}");

    // reserved/promoting 项本地拒绝。
    let mut reserved = item("q1", "sendText", "a");
    reserved["dispatch"] = json!({"state":"reserved"});
    let mut view = queue_view(json!([reserved]), false);
    let error = queue::dispatch(&mut client, &mut view, "/queue delete q1")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("reserved"), "{error}");

    // compact 不可编辑。
    let mut view = queue_view(json!([item("q1", "compact", "summary")]), false);
    let error = queue::dispatch(&mut client, &mut view, "/queue edit q1")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("cannot be edited"), "{error}");

    // sendNow 被 actor availability 否决时本地拒绝。
    let mut view = queue_view(json!([item("q1", "sendText", "a")]), false);
    view.state["availability"]["sendQueuedNow"] =
        json!({"allowed":false,"reasonCode":"guard.queuePromotionBusy"});
    let error = queue::dispatch(&mut client, &mut view, "/queue send q1")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("guard.queuePromotionBusy"), "{error}");
    assert!(recorded.lock().unwrap().is_empty());
    actor.await.unwrap();
}

#[tokio::test]
async fn operation_menu_skips_ops_the_actor_disallows() {
    let mut view = queue_view(
        json!([
            item("q1", "compact", "summary"),
            item("q2", "sendText", "b")
        ]),
        false,
    );
    view.state["availability"]["sendQueuedNow"] =
        json!({"allowed":false,"reasonCode":"guard.queuePromotionBusy"});
    let ((to, mut from), actor, _recorded) = endpoints(Vec::new());
    let mut client = Client::new(&to, &mut from);

    // q2（sendText）：sendNow 被 availability 否决，菜单里不能出现。
    queue::dispatch(&mut client, &mut view, "/queue")
        .await
        .unwrap();
    view.selector.as_mut().unwrap().selected = 1;
    queue::confirm(&mut client, &mut view).await.unwrap();
    let menu = view.selector.take().expect("q2 menu");
    let ops = menu
        .options
        .iter()
        .filter_map(|(choice, _)| match choice {
            Choice::Queue(queue) => queue.op,
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(!ops.contains(&QueueOp::Send));
    assert_eq!(ops, vec![QueueOp::Edit, QueueOp::Up, QueueOp::Delete]);

    // q1（compact）：编辑不可用，只有删除/移动。
    queue::dispatch(&mut client, &mut view, "/queue")
        .await
        .unwrap();
    queue::confirm(&mut client, &mut view).await.unwrap();
    let menu = view.selector.take().expect("compact menu");
    let ops = menu
        .options
        .iter()
        .filter_map(|(choice, _)| match choice {
            Choice::Queue(queue) => queue.op,
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(!ops.contains(&QueueOp::Edit));
    assert_eq!(ops, vec![QueueOp::Down, QueueOp::Delete]);
    actor.await.unwrap();
}
