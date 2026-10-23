//! 队列测试共用的 fake actor、快照与选择器辅助（仅测试编译）。
#![allow(dead_code)]
use crate::{
    client::Client,
    projection::View,
    queue,
    queue_state::QueueOp,
    selector::{Choice, Selector},
};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, ServerMsg};
pub(crate) type Endpoints = (mpsc::Sender<ClientMsg>, mpsc::Receiver<Vec<ServerMsg>>);
pub(crate) type Recorded = Arc<Mutex<Vec<(String, Value)>>>;

/// 记录每个请求的 `method` + `params`，并按顺序回复给定结果。
pub(crate) fn endpoints(replies: Vec<Value>) -> (Endpoints, tokio::task::JoinHandle<()>, Recorded) {
    let (to, mut input) = mpsc::channel(8);
    let (output, from) = mpsc::channel(8);
    let recorded: Recorded = Arc::new(Mutex::new(Vec::new()));
    let seen = recorded.clone();
    let actor = tokio::spawn(async move {
        for reply in replies {
            let ClientMsg::Request {
                token,
                method,
                params,
            } = input.recv().await.expect("expected a request")
            else {
                panic!("expected a request message")
            };
            seen.lock()
                .unwrap()
                .push((method.as_str().to_owned(), params));
            output
                .send(vec![ServerMsg::Reply {
                    token,
                    result: Ok(reply),
                }])
                .await
                .unwrap();
        }
    });
    ((to, from), actor, recorded)
}

pub(crate) fn item(id: &str, kind: &str, text: &str) -> Value {
    json!({"queueItemId":id,"kind":kind,"text":text,"attachments":[],
        "delivery":{"requested":"auto","admitted":"queue"},
        "dispatch":{"state":"queued"},"order":{"queuePosition":0}})
}

pub(crate) fn queue_view(items: Value, auto_drain: bool) -> View {
    let mut view = View::default();
    view.snapshot(&json!({
        "sessionId":"s","seq":1,"logEpoch":"epoch-1","revision":7,
        "rows":{"window":[]},
        "control":{"canStop":true},
        "config":{"mode":"build"},
        "availability":{"queueEdit":{"allowed":true},"sendQueuedNow":{"allowed":true}},
        "queue":{"items":items,"autoDrain":auto_drain},
        "pendingInteractions":[]
    }));
    view
}

pub(crate) fn snapshot_reply(items: Value) -> Value {
    json!({"snapshot":{"sessionId":"s","seq":2,"logEpoch":"epoch-1","revision":8,
        "rows":{"window":[]},"control":{"canStop":true},"config":{"mode":"build"},
        "availability":{"queueEdit":{"allowed":true},"sendQueuedNow":{"allowed":true}},
        "queue":{"items":items,"autoDrain":true},"pendingInteractions":[]}})
}

pub(crate) const ACCEPTED: &str = r#"{"status":"accepted"}"#;
pub(crate) fn accepted() -> Value {
    serde_json::from_str(ACCEPTED).unwrap()
}

/// 跑一条 `/queue ...` 并返回 actor 收到的请求。
pub(crate) async fn run(view: &mut View, text: &str, replies: Vec<Value>) -> Recorded {
    let ((to, mut from), actor, recorded) = endpoints(replies);
    let mut client = Client::new(&to, &mut from);
    queue::dispatch(&mut client, view, text).await.unwrap();
    actor.await.unwrap();
    recorded
}

pub(crate) fn select(selector: &mut Selector, op: QueueOp) -> bool {
    match selector
        .options
        .iter()
        .position(|(choice, _)| matches!(choice, Choice::Queue(queue) if queue.op == Some(op)))
    {
        Some(position) => {
            selector.selected = position;
            true
        }
        None => false,
    }
}

pub(crate) fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
