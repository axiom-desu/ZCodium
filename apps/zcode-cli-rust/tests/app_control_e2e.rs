#![allow(dead_code)]
//! 3.18 App 会话控制（R7b）的真实 Engine 纵向：真实 NodeStore SQLite、真实 WorkspaceTools、
//! loopback provider 与真实 Host 请求/回执帧（`appControl/<intent>`）。
//!
//! 夹具扮演 Host 一端：`runtimeConfig.appControl` 等价于 Host 能力回包（`appControlEnabled`）
//! 经 app-server 写入的同一事实；规格见 `.agents/specs/upstream-3.18-rust-app-control-discovery.md`。
#[path = "tool_search_e2e/fixture.rs"]
mod fixture;
#[path = "tool_search_e2e/harness.rs"]
mod harness;

use fixture::{Fixture, text_reply, tool_reply, tools};
use serde_json::{Value, json};
use std::sync::Arc;

const LIST_PROJECTS: &str = "appControl/listProjects";
const SEND: &str = "appControl/sendToSession";
const RENAME: &str = "appControl/renameSession";

fn tool_names(body: &Value) -> Vec<String> {
    tools(body).into_iter().map(|(name, _)| name).collect()
}

fn granted_runtime() -> Value {
    json!({"toolSearch": {"mode": "off"}, "appControl": true})
}

/// Host 已完成的运行时偏好经既有 `session/create.runtimeConfig` 通道进入本次
/// materialization（等价于 app-server 收到 `appControlEnabled` 回包后写入的同一事实）。
async fn create_with_runtime(
    h: &mut harness::Harness,
    id: u64,
    execution: &str,
    runtime: Value,
) -> String {
    let workspace = h.workspace.clone();
    let reply = h
        .request(
            id,
            "session/create",
            json!({
                "workspace": {"workspacePath": workspace, "workspaceKey": workspace},
                "mode": execution,
                "runtimeConfig": runtime,
            }),
        )
        .await;
    reply["result"]["session"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_owned()
}

/// 需要宿主能力的 12 个工具名（夹具只断言集合，文案/schema 由生成资产决定）。
const APP_TOOLS: [&str; 12] = [
    "ListProjects",
    "ListSessions",
    "ReadSession",
    "CreateSession",
    "ForkSession",
    "SendToSession",
    "WaitSessions",
    "InterruptSession",
    "RenameSession",
    "OpenSession",
    "SetSessionArchived",
    "SetSessionPinned",
];

/// 授予时注册 12 个工具，请求只带可信身份与模型 `input`。
#[tokio::test]
async fn a_granted_root_registers_twelve_tools_and_sends_trusted_identity() {
    let script = vec![
        tool_reply("call-1", "ListProjects", json!({"query": "zc"})),
        text_reply("Listed."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = create_with_runtime(&mut h, 1, "yolo", granted_runtime()).await;
    h.send(2, &session, "list my projects").await;
    let host = h.wait_host_request(LIST_PROJECTS).await;
    // strict 身份：模型输入不能提供 callerSessionId/callId/turnId。
    assert_eq!(
        host["params"],
        json!({
            "callerSessionId": session,
            "callId": "call-1",
            "input": {"query": "zc"},
        })
    );
    h.host_reply(
        host["id"].as_str().unwrap(),
        json!({"ok":true,"result":{"projects":[],"searchScope":{"scopes":[]}}}),
    )
    .await;
    h.settled(&session, 1).await;

    let bodies = h.bodies();
    let names = tool_names(&bodies[0]);
    for name in APP_TOOLS {
        assert!(names.iter().any(|n| n == name), "{name} missing: {names:?}");
    }
    // Host 的成功结果原样回到模型（封闭信封被拆开，result 保留）。
    assert!(
        bodies[1].to_string().contains("\\\"projects\\\":[]"),
        "{:#?}",
        bodies[1]
    );
    assert_eq!(h.host_requests(LIST_PROJECTS).len(), 1);
}

/// 没有 Host 能力（TUI/无头/旧 Host/未装配）：不注册，强行调用不发请求。
#[tokio::test]
async fn without_the_host_capability_the_tools_stay_hidden() {
    let script = vec![
        tool_reply("call-1", "ListProjects", json!({})),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session =
        create_with_runtime(&mut h, 1, "yolo", json!({"toolSearch": {"mode": "off"}})).await;
    h.send(2, &session, "just a normal turn").await;
    h.settled(&session, 1).await;
    let bodies = h.bodies();
    let names = tool_names(&bodies[0]);
    for name in APP_TOOLS {
        assert!(
            !names.iter().any(|n| n == name),
            "{name} registered: {names:?}"
        );
    }
    assert!(
        bodies[1]
            .to_string()
            .contains("Session control is unavailable in this execution context."),
        "{:#?}",
        bodies[1]
    );
    assert!(h.host_requests(LIST_PROJECTS).is_empty());
}

/// 重试身份由工具层注入：`retryOf` 变 `requestId`，顶层身份不可伪造。
#[tokio::test]
async fn retry_identity_is_injected_and_the_caller_identity_is_not_model_controlled() {
    let script = vec![
        tool_reply(
            "call-7",
            "SendToSession",
            json!({
                "sessionId": "s2",
                "prompt": "hi",
                "retryOf": "req-3",
                "callerSessionId": "s-evil",
                "callId": "call-evil",
            }),
        ),
        text_reply("Sent."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = create_with_runtime(&mut h, 1, "yolo", granted_runtime()).await;
    h.send(2, &session, "send it").await;
    let host = h.wait_host_request(SEND).await;
    assert_eq!(host["params"]["callerSessionId"], session);
    assert_eq!(host["params"]["callId"], "call-7");
    assert_eq!(host["params"]["input"]["requestId"], "req-3");
    assert!(host["params"]["input"].get("retryOf").is_none());
    // 伪造的身份只能留在 input 里：Host 的 strict 输入 schema 是唯一否决点，Rust 不改写。
    assert_eq!(host["params"]["input"]["callerSessionId"], "s-evil");
    h.host_reply(
        host["id"].as_str().unwrap(),
        json!({"ok":false,"error":{"code":"invalid_params","message":"invalid input"}}),
    )
    .await;
    h.settled(&session, 1).await;
    let bodies = h.bodies();
    let result = bodies[1].to_string();
    assert!(result.contains("invalid_params"), "{result}");
    assert!(result.contains("invalid input"), "{result}");
    assert!(!result.contains("Sent."), "{result}");
}

/// 只读意图带 `retryOf` 是参数错误：不发送请求，也不把身份静默写进 input。
#[tokio::test]
async fn a_read_intent_refuses_a_retry_identity_without_a_host_request() {
    let script = vec![
        tool_reply(
            "call-1",
            "ReadSession",
            json!({"sessionId":"s2","retryOf":"req-1"}),
        ),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = create_with_runtime(&mut h, 1, "yolo", granted_runtime()).await;
    h.send(2, &session, "read it").await;
    h.settled(&session, 1).await;
    let bodies = h.bodies();
    let result = bodies[1].to_string();
    assert!(
        result.contains("This tool does not accept retryOf"),
        "{result}"
    );
    assert!(h.host_requests("appControl/readSession").is_empty());
}

/// 缺失回执（旧 Host `-32601` / 参数拒绝 `-32602` 投影成 null）不是成功，也不是
/// 「未生效」：文案保留 unknown 语义。
#[tokio::test]
async fn a_missing_acknowledgement_is_an_unknown_outcome() {
    let script = vec![
        tool_reply(
            "call-1",
            "RenameSession",
            json!({"sessionId":"s2","title":"new"}),
        ),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = create_with_runtime(&mut h, 1, "yolo", granted_runtime()).await;
    h.send(2, &session, "rename").await;
    let host = h.wait_host_request(RENAME).await;
    h.host_reply(host["id"].as_str().unwrap(), Value::Null)
        .await;
    h.settled(&session, 1).await;
    let bodies = h.bodies();
    let result = bodies[1].to_string();
    assert!(result.contains("the outcome is unknown"), "{result}");
    assert!(!result.contains("not applied"), "{result}");
    assert!(!result.contains("renamed"), "{result}");
}

/// Host 自己的 `unknown` 状态是结论，原样保留。
#[tokio::test]
async fn a_host_unknown_status_is_kept_as_the_result() {
    let script = vec![
        tool_reply(
            "call-1",
            "RenameSession",
            json!({"sessionId":"s2","title":"new"}),
        ),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = create_with_runtime(&mut h, 1, "yolo", granted_runtime()).await;
    h.send(2, &session, "rename").await;
    let host = h.wait_host_request(RENAME).await;
    h.host_reply(
        host["id"].as_str().unwrap(),
        json!({"ok":true,"result":{"status":"unknown","requestId":"req-1"}}),
    )
    .await;
    h.settled(&session, 1).await;
    let bodies = h.bodies();
    let result = bodies[1].to_string();
    assert!(
        result.contains("\\\"status\\\":\\\"unknown\\\""),
        "{result}"
    );
}

/// 回执按请求 id 归属：伪造/迟到的 id 不能唤醒等待中的调用。
#[tokio::test]
async fn a_reply_id_never_wakes_another_call() {
    let script = vec![
        tool_reply(
            "call-1",
            "RenameSession",
            json!({"sessionId":"s2","title":"new"}),
        ),
        text_reply("Renamed."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = create_with_runtime(&mut h, 1, "yolo", granted_runtime()).await;
    h.send(2, &session, "rename").await;
    let host = h.wait_host_request(RENAME).await;
    // 与真实请求 id 不同：不得被当成这次调用的结论。
    h.host_reply(
        "rust-host-impostor",
        json!({"ok":true,"result":{"status":"renamed"}}),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(fixture.requests(), 1, "tool must still be waiting");
    h.host_reply(
        host["id"].as_str().unwrap(),
        json!({"ok":true,"result":{"status":"renamed","requestId":"req-1"}}),
    )
    .await;
    h.settled(&session, 1).await;
    assert!(
        h.bodies()[1].to_string().contains("renamed"),
        "{:#?}",
        h.bodies()[1]
    );
}

/// 等待期间 stop：取消语义错误，不写成功，也不把 Host 结果当结论。
#[tokio::test]
async fn cancellation_never_reports_the_intent_as_applied() {
    let script = vec![
        tool_reply(
            "call-1",
            "SendToSession",
            json!({"sessionId":"s2","prompt":"hi"}),
        ),
        text_reply("Sent."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = create_with_runtime(&mut h, 1, "yolo", granted_runtime()).await;
    h.send(2, &session, "send it").await;
    let host = h.wait_host_request(SEND).await;
    h.stop(3, &session).await;
    // Host 在取消之后才回执：已释放的 waiter 不能再被唤醒。
    h.host_reply(
        host["id"].as_str().unwrap(),
        json!({"ok":true,"result":{"status":"accepted"}}),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let conn = rusqlite::Connection::open(&h.db).unwrap();
    let persisted: String = conn
        .query_row(
            "select coalesce(group_concat(data, ' '), '') from message where session_id = ?",
            [&session],
            |row| row.get(0),
        )
        .unwrap();
    // 取消的调用不落成功结论，也不产生后续模型请求（那一轮已被停止）。
    assert!(!persisted.contains("accepted"), "{persisted}");
    assert!(!persisted.contains("Sent."), "{persisted}");
    assert_eq!(fixture.requests(), 1);
    let completed: u32 = conn
        .query_row(
            "select count(*) from message where session_id = ?
             and json_extract(data, '$.anchor.boundaryMessageId') is not null",
            [&session],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(completed, 0, "a cancelled turn is not a completed turn");
}
