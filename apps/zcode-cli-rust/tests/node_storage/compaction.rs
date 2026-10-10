// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::*;

#[tokio::test]
async fn manual_compaction_is_stored_as_a_node_summary_and_timeline() {
    let mut h = harness::start(Some("compact"), None).await;
    let session = h.create("c1", "Fix it").await;
    h.settled(&session, 1).await;
    let ack = h.send_text(2, &session, "k1", "/compact").await;
    assert_eq!(ack["status"], "accepted", "{ack}");
    let conn = rusqlite::Connection::open(&h.db).unwrap();
    let summary_stored = || -> bool {
        conn.query_row(
            "select count(*) from message where session_id = ? and json_extract(data, '$.summary.title') = 'Compact summary'",
            [&session],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            == 1
    };
    for _ in 0..250 {
        if summary_stored() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(summary_stored(), "compaction summary persisted");
    let resumed = resume::resume(&conn, &session, &|_| None, None)
        .unwrap()
        .unwrap();
    // 压缩后的模型上下文：摘要成为 context summary，其后没有被保留的旧消息。
    let summary = resumed.history.summary.clone().expect("context summary");
    assert!(
        summary.starts_with("This session is being continued"),
        "{summary}"
    );
    assert!(summary.contains("Fixed the parser."));
    assert!(
        resumed
            .history
            .messages
            .iter()
            .all(|m| m["content"] != "Fix it"),
        "{:#?}",
        resumed.history.messages
    );
    let marker = resumed
        .conversation
        .rows
        .iter()
        .find(|r| r["kind"] == "timelineMarker" && r["marker"]["type"] == "compact")
        .expect("compact marker row");
    assert_eq!(marker["marker"]["origin"], "manual");
    // 压缩命令的回执从时间线 part 的 sourceCommandId 反查（Node timeline 事实）。
    let ack = acks::lookup(&conn, (&session, false), "k1", 0)
        .unwrap()
        .unwrap();
    assert_eq!(ack["status"], "accepted");

    // 压缩后继续对话，模型上下文从摘要开始。
    assert_eq!(
        h.send_text(3, &session, "c2", "Next").await["status"],
        "accepted"
    );
    let conn = h.settled(&session, 2).await;
    let resumed = resume::resume(&conn, &session, &|_| None, None)
        .unwrap()
        .unwrap();
    assert!(resumed.history.summary.is_some());
    assert_eq!(user_texts(&conn, &session), [json!("Next")]);
    harness::dump(&h, &conn, &session);
}
