// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! The engine over the Node session database (spec rust-m11-node-storage
//! §5.2 acceptance): turns are written as Node records, and Node's cold
//! readers give back the live model context and rows, across a restart.
#[path = "node_storage/attach.rs"]
mod attach;
#[path = "node_storage/files.rs"]
mod files;
#[path = "node_storage/goal.rs"]
mod goal;
#[path = "node_storage/grants.rs"]
mod grants;
#[path = "node_storage/harness.rs"]
mod harness;
#[path = "node_storage/input_history.rs"]
mod input_history;
#[path = "node_storage/model.rs"]
mod model;
#[path = "node_storage/shared.rs"]
mod shared;
#[path = "node_storage/side_chat.rs"]
mod side_chat;
#[path = "node_storage/tools.rs"]
mod tools;

use serde_json::{Value, json};
use tokio::sync::oneshot;
use zcode_cli_state::node::{acks, inputs, resume, sessions};

#[tokio::test]
async fn a_tool_turn_is_stored_as_node_records_and_reads_back_as_the_live_context() {
    let mut h = harness::start(None, None).await;
    let session = h.create("c1", "Fix it").await;
    assert!(session.starts_with("sess_"), "{session}");
    let conn = h.settled(&session, 1).await;
    let _first = h.requests.recv().await.unwrap();
    let second = h.requests.recv().await.unwrap();

    let row = sessions::get(&conn, &session).unwrap().unwrap();
    assert_eq!(row.title, "Fix it");
    assert_eq!(row.title_source, "first_input");
    assert_eq!(row.directory, h.workspace);
    let ledger = inputs::get(&conn, "queue_c1").unwrap().unwrap();
    assert_eq!(ledger.status, "promoted");
    assert_eq!(ledger.payload["sourceCommandType"], "createSession");

    let resumed = resume::resume(&conn, &session, &|_| None, None)
        .unwrap()
        .unwrap();
    // 冷读取的模型上下文等于第二次请求看到的对话，再加上最终回答；
    // 环境上下文提醒只在请求时注入，Node 同样不落库。
    let live: Vec<Value> = second
        .into_iter()
        .filter(|m| m["role"] != "system")
        .filter(|m| {
            !m["content"]
                .as_str()
                .is_some_and(|c| c.starts_with("<system-reminder>"))
        })
        .map(|mut m| {
            m.as_object_mut().unwrap().remove("_zcode_request_content");
            m
        })
        .collect();
    let cold = &resumed.history.messages;
    assert_eq!(cold[..live.len()], live[..], "{cold:#?}");
    assert_eq!(cold.len(), live.len() + 1);
    assert_eq!(cold.last().unwrap()["content"], "Done.");
    let kinds: Vec<&str> = resumed
        .conversation
        .rows
        .iter()
        .filter_map(|r| r["kind"].as_str())
        .collect();
    for kind in [
        "turnHeader",
        "userInput",
        "reasoning",
        "assistantText",
        "toolCall",
    ] {
        assert!(kinds.contains(&kind), "{kind} in {kinds:?}");
    }
    let tool = resumed
        .conversation
        .rows
        .iter()
        .find(|r| r["kind"] == "toolCall")
        .unwrap();
    assert_eq!(tool["status"], "success");
    assert_eq!(resumed.model_selection.as_ref().unwrap()["modelId"], "m");
    assert_eq!(resumed.execution.as_ref().unwrap()["mode"], "yolo");

    // 重复的 createSession 与 sendText 命令从耐久事实得到回执。
    let create = acks::lookup_create(&conn, "c1", 0).unwrap().unwrap();
    assert_eq!(create["result"]["sessionId"], session.as_str());
    let transcript = acks::lookup(&conn, (&session, false), "c1", 0)
        .unwrap()
        .unwrap();
    assert_eq!(transcript["status"], "accepted");
}

#[tokio::test]
async fn queued_input_and_a_restarted_runtime_continue_the_node_session() {
    let (started_tx, started) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let mut h = harness::start(Some("restart"), Some((started_tx, release_rx))).await;
    let session = h.create("c1", "Fix it").await;
    started.await.unwrap();
    // 运行中的输入先进入账本（admitted/queue），轮次结束后提升为下一轮。
    let ack = h.send_text(2, &session, "c2", "Then this").await;
    assert_eq!(ack["result"]["delivery"], "queue");
    let conn = rusqlite::Connection::open(&h.db).unwrap();
    let queued = inputs::get(&conn, "queue_c2").unwrap().unwrap();
    assert_eq!(
        (queued.status.as_str(), queued.delivery.as_str()),
        ("admitted", "queue")
    );
    let intent = &queued.payload["conversationInputIntent"];
    assert_eq!(intent["dispatch"]["state"], "queued");
    assert_eq!(intent["order"]["queuePosition"], 0);
    assert_eq!(queued.payload["intent"]["admittedDelivery"], "queue");
    release.send(()).unwrap();
    h.settled(&session, 2).await;
    assert_eq!(
        inputs::get(&conn, "queue_c2").unwrap().unwrap().status,
        "promoted"
    );

    let mut next = harness::restart(&h).await;
    drop(h);
    let ack = next.send_text(3, &session, "c3", "Again").await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    let conn = next.settled(&session, 3).await;
    let resumed = resume::resume(&conn, &session, &|_| None, None)
        .unwrap()
        .unwrap();
    let users: Vec<&Value> = resumed
        .history
        .messages
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| &m["content"])
        .collect();
    assert_eq!(
        users,
        [&json!("Fix it"), &json!("Then this"), &json!("Again")]
    );
    assert_eq!(resumed.history.messages.len(), 12);
    let headers = resumed
        .conversation
        .rows
        .iter()
        .filter(|r| r["kind"] == "turnHeader")
        .count();
    assert_eq!(headers, 3);
    let sources: Vec<&Value> = resumed
        .conversation
        .rows
        .iter()
        .filter(|r| r["kind"] == "userInput")
        .map(|r| &r["sourceCommandId"])
        .collect();
    assert_eq!(sources, [&json!("c1"), &json!("c2"), &json!("c3")]);
    harness::dump(&next, &conn, &session);
}

#[tokio::test]
async fn guided_and_removed_busy_inputs_are_recorded_like_node() {
    let (started_tx, started) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let mut h = harness::start(Some("guide"), Some((started_tx, release_rx))).await;
    let session = h.create("c1", "Fix it").await;
    started.await.unwrap();
    let guide = json!({"commandId": "c2", "clientId": "cli", "sessionId": session,
        "type": "sendText", "issuedAt": 1, "payload": {"text": "Also this", "requestedDelivery": "guide"}});
    assert_eq!(h.command(2, guide).await["status"], "accepted");
    let queued = h.send_text(3, &session, "c3", "Drop me").await;
    let delete = json!({"commandId": "d1", "clientId": "cli", "sessionId": session,
        "type": "deleteQueueItem", "issuedAt": 1, "baseRevision": queued["revisionAtDecision"],
        "payload": {"queueItemId": "queue_c3"}});
    assert_eq!(h.command(4, delete).await["status"], "accepted");
    release.send(()).unwrap();
    let conn = h.settled(&session, 1).await;
    let _first = h.requests.recv().await.unwrap();
    let second = h.requests.recv().await.unwrap();

    let guided = inputs::get(&conn, "queue_c2").unwrap().unwrap();
    assert_eq!(guided.status, "promoted");
    let removed = inputs::get(&conn, "queue_c3").unwrap().unwrap();
    assert_eq!(
        (removed.status.as_str(), removed.status_reason.as_deref()),
        ("cancelled", Some("user_removed"))
    );
    let ack = acks::lookup(&conn, (&session, false), "c3", 0)
        .unwrap()
        .unwrap();
    assert_eq!(ack["reasonCode"], "fault.command.inputCancelled");

    // 引导输入在同一轮内、以插话形态进入模型上下文，冷读取与运行时一致。
    let resumed = resume::resume(&conn, &session, &|_| None, None)
        .unwrap()
        .unwrap();
    let live: Vec<Value> = second
        .into_iter()
        .filter(|m| m["role"] != "system")
        .filter(|m| {
            !m["content"]
                .as_str()
                .is_some_and(|c| c.starts_with("<system-reminder>"))
        })
        .collect();
    let cold = &resumed.history.messages;
    assert_eq!(cold[..live.len()], live[..], "{cold:#?}");
    assert!(
        live.last().unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("Also this")
    );
    let headers = resumed
        .conversation
        .rows
        .iter()
        .filter(|r| r["kind"] == "turnHeader")
        .count();
    assert_eq!(headers, 1, "a guided input stays in its turn");
    harness::dump(&h, &conn, &session);
}

/// `{rowId, entityId}` of the last row of `kind` (real user for inputs).
fn target(rows: &[Value], kind: &str) -> Value {
    let row = rows
        .iter()
        .rev()
        .find(|r| r["kind"] == kind && (kind != "userInput" || r["origin"] == "realUser"))
        .expect("target row");
    json!({"rowId": row["rowId"], "entityId": row["entityId"]})
}

fn user_texts(conn: &rusqlite::Connection, session: &str) -> Vec<Value> {
    let resumed = resume::resume(conn, session, &|_| None, None)
        .unwrap()
        .unwrap();
    resumed
        .history
        .messages
        .iter()
        .filter(|m| m["role"] == "user" && m.get("_zcode_source").is_none())
        .map(|m| m["content"].clone())
        .collect()
}

#[path = "node_storage/branch.rs"]
mod branch;
#[path = "node_storage/compaction.rs"]
mod compaction;
#[path = "node_storage/subagents.rs"]
mod subagents;

#[tokio::test]
async fn reserved_session_id_freezes_additional_directories_and_reconciles_after_delete() {
    let mut h = harness::start(None, None).await;
    let workspace = h.workspace.clone();
    // Host 预留 ID + prepareSession 冻结目录同批到达。
    let ack = h
        .command(
            1,
            json!({"commandId":"create-reserved","clientId":"cli","sessionId":null,
            "type":"createSession","issuedAt":1,"payload":{
                "sessionId":"sess_reserved",
                "additionalDirectories":["/shared"],
                "workspaceId":workspace,
                "config":{"mode":"yolo"},
                "firstInput":{"text":"Fix it"}}}),
        )
        .await;
    assert_eq!(ack["result"]["sessionId"], "sess_reserved");
    let first = h.requests.recv().await.unwrap();
    // 模型可见环境必须带上本次冻结的附加目录。
    assert!(first.iter().any(
        |message| message["content"].as_str().is_some_and(|content| {
            content.contains("Additional directories") && content.contains("/shared")
        })
    ));
    h.settled("sess_reserved", 1).await;

    let reconcile = h
        .request(
            2,
            "v4/sessionsIndex/reconcile",
            json!({"workspaceId":workspace,"sessionIds":["sess_reserved","missing"]}),
        )
        .await;
    assert_eq!(reconcile["sessions"][0]["exists"], true);
    assert_eq!(reconcile["sessions"][0]["deleted"], false);
    assert_eq!(
        reconcile["sessions"][1],
        json!({"sessionId":"missing","exists":false,"deleted":false})
    );
    let foreign = h
        .request(
            3,
            "v4/sessionsIndex/reconcile",
            json!({"workspaceId":"/elsewhere","sessionIds":["sess_reserved"]}),
        )
        .await;
    assert_eq!(foreign["sessions"][0]["exists"], false);

    h.command(
        4,
        json!({"commandId":"delete-reserved","clientId":"cli","sessionId":"sess_reserved",
        "type":"deleteSession","issuedAt":1,"payload":{}}),
    )
    .await;
    let deleted = h
        .request(
            5,
            "v4/sessionsIndex/reconcile",
            json!({"workspaceId":workspace,"sessionIds":["sess_reserved"]}),
        )
        .await;
    assert_eq!(deleted["sessions"][0]["deleted"], true);
    assert_eq!(deleted["sessions"][0]["exists"], true);

    let mut restarted = harness::restart(&h).await;
    let cold = restarted
        .request(
            1,
            "v4/sessionsIndex/reconcile",
            json!({"workspaceId":workspace,"sessionIds":["sess_reserved"]}),
        )
        .await;
    assert_eq!(cold["sessions"][0]["deleted"], true);
    assert_eq!(cold["sessions"][0]["exists"], true);
}

#[tokio::test]
async fn cold_resume_freezes_subscribe_directories_and_hot_resume_ignores_late_ones() {
    let mut h = harness::start(None, None).await;
    let workspace = h.workspace.clone();
    let ack = h
        .command(
            1,
            json!({"commandId":"create-dirs","clientId":"cli","sessionId":null,
            "type":"createSession","issuedAt":1,"payload":{
                "sessionId":"sess_dirs","additionalDirectories":["/first"],
                "workspaceId":workspace.clone(),"config":{"mode":"yolo"},
                "firstInput":{"text":"Fix it"}}}),
        )
        .await;
    assert_eq!(ack["result"]["sessionId"], "sess_dirs");
    h.settled("sess_dirs", 1).await;
    let _first = h.requests.recv().await.unwrap();

    let mut cold = harness::restart(&h).await;
    cold.request(
        1,
        "v4/conversation/subscribe",
        json!({"topic":"conversation/sess_dirs","connectionId":"c1",
            "clientMode":"desktop-continuous","additionalDirectories":["/cold"]}),
    )
    .await;
    cold.send_text(2, "sess_dirs", "after-cold", "Next").await;
    let cold_request = cold.requests.recv().await.unwrap();
    let rendered = serde_json::to_string(&cold_request).unwrap();
    assert!(rendered.contains("/cold"), "{rendered}");
    assert!(!rendered.contains("/first"), "{rendered}");

    // 热会话：后到的订阅目录不得反向改既有 runtime 合同。
    cold.request(
        3,
        "v4/conversation/subscribe",
        json!({"topic":"conversation/sess_dirs","connectionId":"c2",
            "clientMode":"desktop-continuous","additionalDirectories":["/late"]}),
    )
    .await;
    cold.send_text(4, "sess_dirs", "after-hot", "Next").await;
    let hot_request = cold.requests.recv().await.unwrap();
    let rendered = serde_json::to_string(&hot_request).unwrap();
    assert!(rendered.contains("/cold"), "{rendered}");
    assert!(!rendered.contains("/late"), "{rendered}");
}
