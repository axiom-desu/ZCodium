// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! Input history of a real engine over the Node database (spec
//! cli-rust-tui-workbench §1): only the accepted root prompts of an idle
//! (`prompt`) or busy (`steered_input`) input are recorded, once per accepted
//! command, in the transaction that writes the input row and its ACK.
use super::harness;
use serde_json::{Value, json};
use tokio::sync::oneshot;

/// `(text, kind, project)` of every history row, newest first.
fn history(conn: &rusqlite::Connection) -> Vec<(String, String, String)> {
    let mut statement = conn
        .prepare(
            "select text, kind, project_id from input_history order by time_created desc, id desc",
        )
        .unwrap();
    statement
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn texts(conn: &rusqlite::Connection) -> Vec<String> {
    let mut texts: Vec<String> = history(conn).into_iter().map(|(text, _, _)| text).collect();
    texts.reverse();
    texts
}

/// A `sendText` while a turn is running.
async fn busy(
    h: &mut harness::Harness,
    id: u64,
    session: &str,
    command: &str,
    text: &str,
) -> Value {
    h.command(
        id,
        json!({"commandId": command, "clientId": "cli", "sessionId": session,
            "type": "sendText", "issuedAt": 1, "payload": {"text": text}}),
    )
    .await
}

#[tokio::test]
async fn accepted_root_prompts_are_recorded_once_and_promotions_are_not() {
    let (started, started_rx) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let mut h = harness::start(None, Some((started, released))).await;
    let session = h.create("c1", "Fix it").await;
    // 首轮的工具步骤先等在这里：期间输入才是 busy 输入。
    started_rx.await.unwrap();

    let conn = rusqlite::Connection::open(&h.db).unwrap();
    // createSession 的 firstInput 是 idle prompt；scope 是完整 identity key，
    // 不是 `proj_*` slug。
    let scope = zcode_cli_state::node::input_history::scope(&h.workspace);
    assert_eq!(
        history(&conn),
        [("Fix it".into(), "prompt".into(), scope.clone())]
    );

    let ack = busy(&mut h, 10, &session, "c2", "Steer it").await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    let rows = history(&conn);
    assert_eq!(
        rows.iter()
            .map(|(text, kind, _)| (text.as_str(), kind.as_str()))
            .collect::<Vec<_>>(),
        [("Steer it", "steered_input"), ("Fix it", "prompt")]
    );

    // 忙时拒绝的输入不写历史。
    let rejected = h
        .command(
            11,
            json!({"commandId": "c3", "clientId": "cli", "sessionId": session,
                "type": "sendText", "issuedAt": 1,
                "payload": {"text": "Blocked", "modelExecution": {}}}),
        )
        .await;
    assert_ne!(rejected["status"], "accepted", "{rejected}");
    assert_eq!(texts(&conn), ["Fix it", "Steer it"]);

    // 队列提升不重复记录：busy 输入只有它被接受时的那一条。
    release.send(()).unwrap();
    let conn = h.settled(&session, 2).await;
    assert_eq!(texts(&conn), ["Fix it", "Steer it"]);

    // 空闲时接受的 sendText 是 prompt；同 commandId 重放不再新增。
    let ack = h.send_text(20, &session, "c4", "Second prompt").await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    let conn = h.settled(&session, 3).await;
    assert_eq!(texts(&conn), ["Fix it", "Steer it", "Second prompt"]);
    // 同一 commandId 的重放由持久 ACK 判为 duplicate，不再产生历史。
    let replay = h.send_text(21, &session, "c4", "Second prompt").await;
    assert_eq!(replay["status"], "duplicate", "{replay}");
    assert_eq!(texts(&conn), ["Fix it", "Steer it", "Second prompt"]);
    // 旧 TS 的 `proj_*` 历史不迁移也不混入。
    assert!(
        history(&conn)
            .iter()
            .all(|(_, _, project)| project == &scope)
    );
}
