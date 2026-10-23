//! 只读查询票据与 MCP 刷新时机（spec cli-rust-tui-workbench §3「请求票据」）。
#![allow(clippy::field_reassign_with_default)]

use crate::{
    client::{Client, QueryKind},
    projection::View,
    projection_tests::request,
    session, telemetry,
};
use serde_json::json;
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, Method, RuntimeEvent, ServerMsg};

fn view() -> View {
    let mut view = View::default();
    view.snapshot(&json!({"sessionId":"s","seq":0,"rows":{"window":[]},
        "control":{"canStop":false,"phase":"draft"},"config":{"mode":"build"},"pendingInteractions":[]}));
    view
}

/// 历史读请求用 `SessionList` 当占位方法：本模块不实现历史 backend，也不假造结果。
fn start(client: &mut Client<'_>, view: &View, kind: QueryKind) -> bool {
    client
        .start_query(view, kind, Method::SessionList, json!({}))
        .unwrap()
}

async fn request_of(input: &mut mpsc::Receiver<ClientMsg>) -> (u64, Method) {
    match input.recv().await.expect("actor received a request") {
        ClientMsg::Request { token, method, .. } => (token, method),
        other => panic!("unexpected client message: {other:?}"),
    }
}

/// 延迟的 MCP 回包不能阻塞 stop；回包晚到后仍进完成队列。
#[tokio::test]
async fn delayed_mcp_reply_never_blocks_stop() {
    let (to, mut input) = mpsc::channel(8);
    let (output, mut from) = mpsc::channel(8);
    let actor = tokio::spawn(async move {
        let (mcp_token, method) = request_of(&mut input).await;
        assert_eq!(method, Method::McpList);
        let (stop_token, method) = request_of(&mut input).await;
        assert_eq!(method, Method::Command);
        output
            .send(vec![ServerMsg::Reply {
                token: stop_token,
                result: Ok(json!({"status":"accepted"})),
            }])
            .await
            .unwrap();
        output
            .send(vec![ServerMsg::Reply {
                token: mcp_token,
                result: Ok(json!({"statuses":{}})),
            }])
            .await
            .unwrap();
    });
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    assert!(
        client
            .start_query(
                &view,
                QueryKind::McpStatus,
                Method::McpList,
                json!({"mode":"status"})
            )
            .unwrap()
    );
    // stop 必须在 MCP 回包之前完成。
    session::stop(&mut client, &mut view).await.unwrap();
    assert!(client.take_read_replies().is_empty());
    let message = client.next().await.unwrap();
    client.observe(&mut view, message).await.unwrap();
    let replies = client.take_read_replies();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].kind, QueryKind::McpStatus);
    actor.await.unwrap();
}

/// 同步 call 中穿插的只读回包走完成队列，call 仍拿到自己的结果且事件顺序不变。
#[tokio::test]
async fn read_reply_inside_blocking_call_is_split_not_swallowed() {
    let (to, mut input) = mpsc::channel(8);
    let (output, mut from) = mpsc::channel(8);
    let actor = tokio::spawn(async move {
        let (mcp_token, _) = request_of(&mut input).await;
        let (list_token, method) = request_of(&mut input).await;
        assert_eq!(method, Method::SessionList);
        output
            .send(vec![
                ServerMsg::Event(RuntimeEvent::ConversationDeltas {
                    session: "s".into(),
                    from: 0,
                    to: 1,
                    deltas: zcode_cli_domain::topic_log::sized(vec![
                        json!({"op":"row.appended","row":{"rowId":"a","kind":"assistantText","text":"before"}}),
                    ]),
                    ttft: vec![],
                }),
                ServerMsg::Reply {
                    token: mcp_token,
                    result: Ok(json!({"statuses":{}})),
                },
                ServerMsg::Reply {
                    token: list_token,
                    result: Ok(json!({"sessions":[]})),
                },
            ])
            .await
            .unwrap();
    });
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    client
        .start_query(
            &view,
            QueryKind::McpStatus,
            Method::McpList,
            json!({"mode":"status"}),
        )
        .unwrap();
    let listed = client
        .call(&mut view, Method::SessionList, json!({}))
        .await
        .unwrap();
    assert_eq!(listed["sessions"], json!([]));
    assert_eq!(view.rows[0]["text"], "before");
    assert_eq!(client.pending_orphan_replies(), 0);
    assert_eq!(client.take_read_replies().len(), 1);
    actor.await.unwrap();
}

/// 未知 token（已放弃/过期）只在有界窗口内保留。
#[tokio::test]
async fn unknown_tokens_do_not_accumulate_without_bound() {
    let (to, _input) = mpsc::channel(8);
    let (_output, mut from) = mpsc::channel(8);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    for token in 1_000..1_100 {
        client
            .observe(
                &mut view,
                ServerMsg::Reply {
                    token,
                    result: Ok(json!({"late":token})),
                },
            )
            .await
            .unwrap();
    }
    assert!(client.pending_orphan_replies() <= 8);
}

/// 同 id 重新进入（新 generation）后旧票据不能覆盖新状态，也不能一直占住 class slot。
#[tokio::test]
async fn stale_generation_reply_is_dropped_and_releases_the_slot() {
    let (to, mut input) = mpsc::channel(8);
    let (output, mut from) = mpsc::channel(8);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    assert!(start(&mut client, &view, QueryKind::History { skip: 0 }));
    let (token, _) = request_of(&mut input).await;
    let old_generation = view.generation;
    // TopicClosed 推进 generation 并清空遥测，但保留同一 session id。
    client
        .observe(
            &mut view,
            ServerMsg::Event(RuntimeEvent::TopicClosed {
                topic: "conversation/s".into(),
            }),
        )
        .await
        .unwrap();
    assert!(view.generation > old_generation);
    let notices_before = view.notices.len();
    output
        .send(vec![ServerMsg::Reply {
            token,
            result: Ok(json!({"rows":[{"text":"old"}]})),
        }])
        .await
        .unwrap();
    let message = client.next().await.unwrap();
    client.observe(&mut view, message).await.unwrap();
    for reply in client.take_read_replies() {
        let generation = reply.generation;
        telemetry::apply_reply(&mut view, reply);
        assert_eq!(generation, old_generation);
    }
    // 历史由 F 分流：即使拿到旧结果也没有伪造任何 telemetry 事实。
    assert!(view.telemetry.mcp_servers.is_empty());
    assert_eq!(view.notices.len(), notices_before);
    // 过期票据释放 slot：新 generation 立刻可以发起同类查询。
    assert!(start(&mut client, &view, QueryKind::History { skip: 3 }));
}

/// 同一 class 合并（含不同 skip 的历史翻页），不接受第二笔。
#[tokio::test]
async fn one_ticket_per_read_class_and_skip_cannot_bypass_it() {
    let (to, mut input) = mpsc::channel(8);
    let (output, mut from) = mpsc::channel(8);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    assert!(start(&mut client, &view, QueryKind::History { skip: 0 }));
    assert!(!start(&mut client, &view, QueryKind::History { skip: 5 }));
    let (token, _) = request_of(&mut input).await;
    output
        .send(vec![ServerMsg::Reply {
            token,
            result: Ok(json!({"rows":[]})),
        }])
        .await
        .unwrap();
    // 完成但未消费同样占位，避免前端卡顿后重复请求。
    let message = client.next().await.unwrap();
    client.observe(&mut view, message).await.unwrap();
    assert!(!start(&mut client, &view, QueryKind::History { skip: 0 }));
    assert_eq!(client.take_read_replies().len(), 1);
    assert!(start(&mut client, &view, QueryKind::History { skip: 0 }));
}

/// pump 只在明确时机发一次：不随 50ms 重绘反复请求，也不能叠加第二笔。
#[tokio::test]
async fn pump_does_not_storm_mcp_requests() {
    let (to, mut input) = mpsc::channel(32);
    let (output, mut from) = mpsc::channel(32);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    let request = request();
    for _ in 0..20 {
        telemetry::pump(&mut client, &mut view, &request);
    }
    let tokens = drained(&mut input);
    assert_eq!(tokens.len(), 1);
    assert!(view.telemetry.mcp_loading);
    settle(&mut client, &mut view, &output, tokens[0]).await;

    // 没有 dirty 时机时，重绘不再发查询。
    for _ in 0..10 {
        telemetry::pump(&mut client, &mut view, &request);
    }
    assert!(drained(&mut input).is_empty());

    // 轮次结束（真实 state.updated）刷新一次；在飞期间侧栏可见不叠加第二笔。
    view.deltas(
        "s",
        0,
        2,
        [
            json!({"op":"state.updated","patch":{"control":{"canStop":true,"phase":"running"}}}),
            json!({"op":"state.updated","patch":{"control":{"canStop":false,"phase":"completed"}}}),
        ]
        .into_iter(),
    );
    telemetry::pump(&mut client, &mut view, &request);
    let tokens = drained(&mut input);
    assert_eq!(tokens.len(), 1, "the real end refreshes once");
    view.sidebar = true;
    telemetry::pump(&mut client, &mut view, &request);
    assert!(drained(&mut input).is_empty());

    // 结果消费后，侧栏重新可见再刷新一次。
    settle(&mut client, &mut view, &output, tokens[0]).await;
    view.sidebar = false;
    telemetry::pump(&mut client, &mut view, &request);
    view.sidebar = true;
    telemetry::pump(&mut client, &mut view, &request);
    assert_eq!(drained(&mut input).len(), 1);
}

/// 同一批 event 里先 running 再 completed，主循环只在之后 pump 一次；
/// 只看最终 phase 的实现会漏掉这次真实结束。
#[tokio::test]
async fn batched_running_then_completed_refreshes_once() {
    let (to, mut input) = mpsc::channel(32);
    let (output, mut from) = mpsc::channel(32);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    let request = request();
    telemetry::pump(&mut client, &mut view, &request);
    let tokens = drained(&mut input);
    assert_eq!(tokens.len(), 1);
    settle(&mut client, &mut view, &output, tokens[0]).await;
    for _ in 0..5 {
        telemetry::pump(&mut client, &mut view, &request);
    }
    assert!(drained(&mut input).is_empty());

    view.deltas(
        "s",
        0,
        2,
        [
            json!({"op":"state.updated","patch":{"control":{"canStop":true,"phase":"running"}}}),
            json!({"op":"state.updated","patch":{"control":{"canStop":false,"phase":"completed"}}}),
        ]
        .into_iter(),
    );
    assert!(view.telemetry.mcp_dirty, "real end sets the refresh flag");
    for _ in 0..30 {
        telemetry::pump(&mut client, &mut view, &request);
    }
    assert_eq!(drained(&mut input).len(), 1, "one refresh per real end");
}

/// 在飞期间出现新的刷新时机不能被 apply 吃掉：下一次 pump 只补发一次。
#[tokio::test]
async fn end_of_turn_during_flight_resends_exactly_once() {
    let (to, mut input) = mpsc::channel(32);
    let (output, mut from) = mpsc::channel(32);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    let request = request();
    telemetry::pump(&mut client, &mut view, &request);
    let tokens = drained(&mut input);
    assert_eq!(tokens.len(), 1);

    view.deltas(
        "s",
        0,
        2,
        [
            json!({"op":"state.updated","patch":{"control":{"canStop":true,"phase":"running"}}}),
            json!({"op":"state.updated","patch":{"control":{"canStop":false,"phase":"completed"}}}),
        ]
        .into_iter(),
    );
    telemetry::pump(&mut client, &mut view, &request);
    assert!(drained(&mut input).is_empty(), "class slot is still busy");

    settle(&mut client, &mut view, &output, tokens[0]).await;
    assert!(
        view.telemetry.mcp_dirty,
        "applying a reply must not clear a trigger raised after the send"
    );
    telemetry::pump(&mut client, &mut view, &request);
    assert_eq!(drained(&mut input).len(), 1, "exactly one follow-up");
    for _ in 0..10 {
        telemetry::pump(&mut client, &mut view, &request);
    }
    assert!(drained(&mut input).is_empty(), "no storm after the resend");
}

fn drained(input: &mut mpsc::Receiver<ClientMsg>) -> Vec<u64> {
    let mut tokens = Vec::new();
    while let Ok(ClientMsg::Request {
        token,
        method,
        params,
    }) = input.try_recv()
    {
        assert_eq!(method, Method::McpList);
        assert_eq!(params["mode"], "status");
        tokens.push(token);
    }
    tokens
}

async fn settle(
    client: &mut Client<'_>,
    view: &mut View,
    output: &mpsc::Sender<Vec<ServerMsg>>,
    token: u64,
) {
    output
        .send(vec![ServerMsg::Reply {
            token,
            result: Ok(json!({"statuses":{}})),
        }])
        .await
        .unwrap();
    let message = client.next().await.unwrap();
    client.observe(view, message).await.unwrap();
    for reply in client.take_read_replies() {
        telemetry::apply_reply(view, reply);
    }
}
