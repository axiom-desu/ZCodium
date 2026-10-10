// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::*;

#[tokio::test]
async fn edit_and_retry_cut_the_node_branch_before_and_after_a_restart() {
    let mut h = harness::start(Some("rewind"), None).await;
    let session = h.create("c1", "Fix it").await;
    h.settled(&session, 1).await;
    let (rows, revision, epoch) = h.rows(2, &session).await;
    let edit = json!({"commandId": "e1", "clientId": "cli", "sessionId": session,
        "type": "editUserQuery", "issuedAt": 1, "baseRevision": revision, "baseLogEpoch": epoch,
        "payload": {"target": target(&rows, "userInput"), "newText": "Fix it better"}});
    let ack = h.command(3, edit).await;
    assert_eq!(ack["result"]["disposition"], "rewind", "{ack}");
    let conn = h.settled(&session, 2).await;
    let row = sessions::get(&conn, &session).unwrap().unwrap();
    let revert = row.revert.unwrap();
    assert_eq!(revert["kind"], "conversation_rewind");
    assert_eq!(revert["branchGeneration"], 1);
    assert_eq!(revert["keptMessageIDs"], json!([]));
    assert_eq!(user_texts(&conn, &session), [json!("Fix it better")]);
    let rerun = inputs::get(&conn, "queue_e1").unwrap().unwrap();
    assert_eq!(rerun.status, "promoted");
    assert_eq!(rerun.payload["sourceCommandType"], "editUserQuery");
    assert_eq!(
        rerun.payload["conversationInputIntent"]["provenance"]["sourceCommandId"],
        "c1"
    );

    let (rows, revision, epoch) = h.rows(4, &session).await;
    let retry = json!({"commandId": "r1", "clientId": "cli", "sessionId": session,
        "type": "retryTurn", "issuedAt": 1, "baseRevision": revision, "baseLogEpoch": epoch,
        "payload": {"target": target(&rows, "assistantText")}});
    assert_eq!(h.command(5, retry).await["status"], "accepted");
    let conn = h.settled(&session, 3).await;
    let revert = sessions::get(&conn, &session)
        .unwrap()
        .unwrap()
        .revert
        .unwrap();
    assert_eq!(revert["branchGeneration"], 2);
    // Node 重试以被重试的 assistant 为请求锚点（保留前缀为空时 messageID 同为该锚点）。
    let anchor_role: String = conn
        .query_row(
            "select json_extract(data, '$.role') from message where id = ?",
            [revert["targetMessageID"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(anchor_role, "assistant");
    assert_eq!(user_texts(&conn, &session), [json!("Fix it better")]);
    let retried = inputs::get(&conn, "queue_r1").unwrap().unwrap();
    // 重试沿用被重试输入的来源（该输入本身来自编辑，来源仍指向 c1）。
    assert_eq!(
        retried.payload["conversationInputIntent"]["provenance"]["sourceCommandId"],
        "c1"
    );

    // 重启后从 Node 记录重建编辑边界，最新输入仍可编辑。
    let mut next = harness::restart(&h).await;
    drop(h);
    let (rows, revision, epoch) = next.rows(6, &session).await;
    let edit = json!({"commandId": "e2", "clientId": "cli", "sessionId": session,
        "type": "editUserQuery", "issuedAt": 1, "baseRevision": revision, "baseLogEpoch": epoch,
        "payload": {"target": target(&rows, "userInput"), "newText": "Third try"}});
    let ack = next.command(7, edit).await;
    assert_eq!(ack["result"]["disposition"], "rewind", "{ack}");
    let conn = next.settled(&session, 4).await;
    let revert = sessions::get(&conn, &session)
        .unwrap()
        .unwrap()
        .revert
        .unwrap();
    assert_eq!(revert["branchGeneration"], 3);
    assert_eq!(user_texts(&conn, &session), [json!("Third try")]);
    let resumed = resume::resume(&conn, &session, &|_| None, None)
        .unwrap()
        .unwrap();
    assert_eq!(resumed.history.messages.len(), 4);
    let headers = resumed
        .conversation
        .rows
        .iter()
        .filter(|r| r["kind"] == "turnHeader")
        .count();
    assert_eq!(headers, 1, "only the active branch is projected");
    harness::dump(&next, &conn, &session);
}

#[tokio::test]
async fn fork_copies_the_stable_segment_into_a_node_child_session() {
    let mut h = harness::start(Some("fork"), None).await;
    let session = h.create("c1", "Fix it").await;
    h.settled(&session, 1).await;
    let (rows, revision, epoch) = h.rows(2, &session).await;
    let fork = json!({"commandId": "f1", "clientId": "cli", "sessionId": session,
        "type": "forkAssistant", "issuedAt": 1, "baseRevision": revision, "baseLogEpoch": epoch,
        "payload": {"target": target(&rows, "assistantText")}});
    let ack = h.command(3, fork).await;
    let child = ack["result"]["sessionId"]
        .as_str()
        .expect("child session")
        .to_owned();
    assert!(child.starts_with("sess_") && child != session, "{ack}");

    let conn = rusqlite::Connection::open(&h.db).unwrap();
    let row = sessions::get(&conn, &child).unwrap().unwrap();
    assert_eq!(row.task_type, "fork");
    assert_eq!(row.parent_id.as_deref(), Some(session.as_str()));
    assert_eq!(row.title, "Fork of Fix it");
    // 父会话记录 child 命令事实：重复的 forkAssistant 从耐久事实得到同一个子会话。
    let fact = acks::lookup(&conn, (&session, false), "f1", 0)
        .unwrap()
        .unwrap();
    assert_eq!(fact["result"]["sessionId"], child.as_str());
    let resumed = resume::resume(&conn, &child, &|_| None, None)
        .unwrap()
        .unwrap();
    let history = &resumed.history.messages;
    assert_eq!(history[0]["content"], "Fix it");
    assert_eq!(
        history.last().unwrap()["_zcode_source"],
        "conversation_fork"
    );
    assert!(
        resumed
            .conversation
            .rows
            .iter()
            .any(|r| r["kind"] == "timelineMarker" || r["kind"] == "sessionFork"),
        "{:#?}",
        resumed.conversation.rows
    );

    // 子会话按冷加载注册，可以继续对话。
    let ack = h.send_text(4, &child, "c2", "Continue here").await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    // 复制的边界、fork 提示的两条消息与新一轮各带一个稳定分段锚点。
    let conn = h.settled(&child, 4).await;
    assert_eq!(
        user_texts(&conn, &child),
        [json!("Fix it"), json!("Continue here")]
    );
    harness::dump(&h, &conn, &child);
}
