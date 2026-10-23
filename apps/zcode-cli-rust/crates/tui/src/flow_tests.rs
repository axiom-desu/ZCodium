//! 非阻塞 workflow 回归：慢 boot/setting/queue/picker/snapshot 与满通道、迟到回包。
//!
//! 这些测试都直接驱动真实状态机（`begin_*` + `pump_flows`/`settle`），不新建第二条发送路径。
use crate::{
    client::Client,
    frontend::{self, Frontend},
    frontend_test_support::{endpoints, next_request, request, view},
    picker, session,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use zcode_cli_core_api::ServerMsg;

fn session_snapshot(id: &str) -> Value {
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

async fn reply(responses: &mpsc::Sender<Vec<ServerMsg>>, token: u64, result: Value) {
    responses
        .send(vec![ServerMsg::Reply {
            token,
            result: Ok(result),
        }])
        .await
        .unwrap();
}

/// boot 的完整四步：create → topicOpen；每一步都在回包到达前返回主循环。
#[tokio::test]
async fn boot_is_nonblocking_and_finishes_the_session_on_reply() {
    let (to, mut requests, responses, mut from) = endpoints();
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
    assert!(client.mutation_flow_busy(), "boot 占住唯一 mutation 槽");
    assert!(view.editor.text().is_empty());

    // 第一步已发出，但还没有任何回包：这里必须能继续编辑/重绘。
    view.editor.insert("typed while booting");
    let (create_token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "session/create");
    assert_eq!(params["persistence"], "immediate");

    reply(
        &responses,
        create_token,
        json!({"session":{"sessionId":"s-new"},"settings":{"model":{"available":[]}}}),
    )
    .await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    // 续步 topicOpen 在同一轮发出。
    let (open_token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "internal/topicOpen");
    assert_eq!(params["topic"], "conversation/s-new");

    reply(&responses, open_token, session_snapshot("s-new")).await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    assert!(!client.mutation_flow_busy());
    assert_eq!(view.session, "s-new");
    assert_eq!(view.editor.text(), "typed while booting", "boot 不碰草稿");
}

/// setting：setter ACK 后同一 workflow 续一步快照，不伪造配置事实。
#[tokio::test]
async fn setting_ack_continues_with_a_snapshot_step_in_the_same_workflow() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    session::begin_setting(
        &mut client,
        &mut view,
        zcode_cli_core_api::Method::SessionSetMode,
        json!({"sessionId":"s","mode":"plan"}),
    )
    .unwrap();
    let (set_token, method, params) = next_request(&mut requests).await;
    assert_eq!(method, "session/setMode");
    assert_eq!(params["mode"], "plan");
    // ACK 未到：配置事实没有被本地改写。
    assert_ne!(view.state["config"]["mode"], "plan");

    reply(&responses, set_token, json!({})).await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    let (snap_token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "internal/topicSnapshot");
    let mut snapshot = session_snapshot("s");
    snapshot["snapshot"]["config"]["mode"] = "plan".into();
    reply(&responses, snap_token, snapshot).await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    assert!(!client.mutation_flow_busy());
    assert_eq!(view.state["config"]["mode"], "plan");
}

/// picker 会话列表迟到：会话/世代已变就不清新菜单、不写新草稿。
#[tokio::test]
async fn late_picker_list_never_replaces_a_newer_selector() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    picker::begin_open(&mut client, &mut view, &request(), "/sessions").unwrap();
    let (token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "session/list");
    // 用户在等待期间打开了另一个真实菜单（本地 /model）。
    picker::begin_open(&mut client, &mut view, &request(), "/model").unwrap();
    view.models = vec![json!({"ref":{"providerId":"p","modelId":"m"}})];
    picker::begin_open(&mut client, &mut view, &request(), "/model").unwrap();
    let owner = view.selector.as_ref().map(|s| s.owner.clone());
    assert_eq!(owner.as_deref(), Some("s"));
    reply(
        &responses,
        token,
        json!({"sessions":[{"sessionId":"other","title":"Other","updatedAt":9}]}),
    )
    .await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    let selector = view.selector.as_ref().unwrap();
    assert_eq!(selector.title, "Models", "迟到的会话列表不得替换新菜单");
    assert_eq!(view.editor.text(), "");
}

/// resync：只读槽单飞，重复 gap 只回拉一次；回包应用后解除。
#[tokio::test]
async fn resync_is_single_flight_and_applied_once() {
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.resync = true;
    poll(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    let (token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "internal/topicSnapshot");
    assert!(requests.try_recv().is_err(), "在飞的 resync 不得重复回拉");
    reply(&responses, token, session_snapshot("s")).await;
    observe(&mut client, &mut view).await;
    poll(&mut client, &mut view).await;
    assert!(!view.resync);
    assert!(requests.try_recv().is_err(), "应用快照后不得继续回拉");
}

/// boot 在飞时按 Enter：明确拒绝、草稿整份保留，不产生第二个 admission。
#[tokio::test]
async fn submit_during_boot_is_rejected_locally_and_keeps_the_draft() {
    let (to, mut requests, _responses, mut from) = endpoints();
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
    let (_create_token, _, _) = next_request(&mut requests).await;
    view.editor.insert("typed while booting");
    view.sync_completion();
    frontend::submit_editor(&mut client, &mut view, &request())
        .await
        .unwrap();
    assert_eq!(
        view.editor.text(),
        "typed while booting",
        "草稿必须整份保留"
    );
    assert!(!view.pending_submit);
    assert!(
        requests.try_recv().is_err(),
        "boot 在飞时不得追加第二个 admission"
    );
    assert!(
        view.notices
            .last()
            .is_some_and(|note| note.contains("starting") || note.contains("打开")),
        "{:?}",
        view.notices.last()
    );
}

/// `/new` 的 boot 在飞时再次 `/sessions`：明确拒绝、整份保留草稿、不产生第二个请求。
/// 旧实现会先把 picker 放进只读槽，boot 快照推进 generation 后把它静默撤销。
#[tokio::test]
async fn session_picker_during_boot_is_rejected_explicitly_and_keeps_the_draft() {
    let (to, mut requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    session::begin_open(
        &mut client,
        &mut view,
        &request(),
        crate::transport::Resume::New,
    )
    .unwrap();
    let (_create_token, method, _) = next_request(&mut requests).await;
    assert_eq!(method, "session/create");
    view.editor.insert("/sessions");
    view.sync_completion();
    frontend::submit_editor(&mut client, &mut view, &request())
        .await
        .unwrap();
    assert_eq!(view.editor.text(), "/sessions", "拒绝必须整份保留草稿");
    assert!(view.selector.is_none(), "boot 在飞时不得打开旧会话菜单");
    assert!(
        view.notices
            .last()
            .is_some_and(|note| note.contains("still opening") || note.contains("正在打开")),
        "{:?}",
        view.notices.last()
    );
    assert!(
        requests.try_recv().is_err(),
        "被拒绝的命令不得追加第二次 admission"
    );
    assert!(client.mutation_flow_busy());
}

/// boot 在飞时帮助栏必须显示派生的 opening 摘要，用户不会误以为命令已消失。
#[tokio::test]
async fn opening_state_is_visible_while_boot_is_in_flight() {
    let (to, mut requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    session::begin_open(
        &mut client,
        &mut view,
        &request(),
        crate::transport::Resume::New,
    )
    .unwrap();
    let (_token, _, _) = next_request(&mut requests).await;
    poll(&mut client, &mut view).await;
    assert_eq!(view.pending, Some(crate::projection::Pending::Opening));
    assert_eq!(view.pending.unwrap().text(false), "Opening session...");
}

/// 迟到的旧 draft 拒绝只丢旧效果，不能把本轮已成功 workflow 的 dirty 压回 false。
#[tokio::test]
async fn stale_draft_rejection_does_not_erase_earlier_dirty_effects() {
    use crate::{
        client_operations::{OpReply, TicketKind},
        operations::OpKind,
    };
    let (to, mut requests, responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("hello");
    view.sync_completion();
    frontend::submit_editor(&mut client, &mut view, &request())
        .await
        .unwrap();
    let (token, _, _) = next_request(&mut requests).await;
    reply(&responses, token, json!({"status":"accepted"})).await;
    observe(&mut client, &mut view).await;
    // 在其后注入一条已过期（无匹配 inflight）的 draft 拒绝。
    client.test_push_completed(OpReply {
        kind: TicketKind::Draft(OpKind::Submit),
        session: "s".into(),
        generation: view.generation,
        epoch: 9_999,
        result: Ok(json!({"status":"rejected","reasonCode":"stale"})),
    });
    let dirty = crate::frontend_operations::settle(&mut client, &mut view)
        .await
        .unwrap();
    assert!(dirty, "旧拒绝不得抹掉本轮合法 effects 的 dirty");
}

/// 控制 outbox 满时 release 必须显式报错，不能提示后假装成功或静默丢弃。
#[tokio::test]
async fn full_control_outbox_reports_release_failure() {
    let (to, _requests, _responses, mut from) = endpoints();
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    for index in 0..16 {
        assert!(client.release_topic(format!("topic-{index}")));
    }
    assert!(!client.release_topic("overflow".into()), "outbox 应已满");
    let dirty = crate::client_control::apply(
        &mut client,
        &mut view,
        crate::flow::Effects {
            dirty: true,
            error: None,
            release: Some("conversation/s".into()),
        },
    );
    assert!(dirty);
    assert!(
        view.notices
            .iter()
            .any(|note| note.contains("could not be released")),
        "{:?}",
        view.notices
    );
}
