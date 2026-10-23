// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! Input history over a real `NodeStore` (spec cli-rust-tui-workbench §1): the
//! row commits with the session's admission writes, survives a reopen, and is
//! scoped by the full workspace identity instead of a path or slug.
use super::NodeStore;
use crate::contract::SessionStore;
use crate::domain::node_journal::{InputHistory, Op};
use crate::domain::session::Session;
use serde_json::{Value, json};

async fn store(dir: &tempfile::TempDir) -> NodeStore {
    let root = dir.path();
    NodeStore::open(
        root.join("db/db.sqlite"),
        root.join("artifacts"),
        root.join("cache"),
    )
    .await
    .unwrap()
}

fn session(id: &str, workspace: &str) -> Session {
    let mut s = Session::new(
        id.into(),
        workspace.into(),
        "p".into(),
        "m".into(),
        "high".into(),
        "e".into(),
        1,
    );
    s.workspace_path = Some(workspace.into());
    s
}

fn history(id: &str, project: &str, text: &str, attachments: Option<Value>) -> InputHistory {
    InputHistory {
        id: id.into(),
        project: project.into(),
        session: Some("sess_1".into()),
        text: text.into(),
        attachments,
        kind: "prompt".into(),
    }
}

/// The engine's journal shape: the session row, then the history row.
fn accepted(
    mut s: Session,
    history_id: &str,
    project: &str,
    text: &str,
    attachments: Option<Value>,
) -> Session {
    s.node_ensure_created(1, text, "test");
    s.node_input_history(2, history(history_id, project, text, attachments));
    s
}

#[tokio::test]
async fn accepted_history_commits_with_the_session_and_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(&dir).await;
    // 两个远端 identity 的路径相同，前缀也相同（只有末尾不同）；按路径或
    // 80 字符 slug 隔离时它们会串在一起。
    let long = "remote://host/workspace/".to_owned() + &"a".repeat(120);
    let first = format!("{long}-first");
    let second = format!("{long}-second");
    let mut a = accepted(
        session("sess_1", &first),
        "hist_a",
        &first,
        "first prompt",
        None,
    );
    db.commit(&first, Some(&mut a), Some(("ack".into(), json!(1))))
        .await
        .unwrap();
    let mut b = accepted(
        session("sess_2", &second),
        "hist_b",
        &second,
        "second prompt",
        Some(json!([{"type":"file","path":"notes.md"}])),
    );
    db.commit(&second, Some(&mut b), Some(("ack".into(), json!(1))))
        .await
        .unwrap();

    let entry = db.recall_input_history(&first, 0).await.unwrap().unwrap();
    assert_eq!(entry["text"], "first prompt");
    assert_eq!(entry["kind"], "prompt");
    assert_eq!(entry["sessionId"], "sess_1");
    assert!(entry["attachments"].is_null(), "{entry}");
    assert!(entry["timeCreated"].as_i64().is_some(), "{entry}");
    let entry = db.recall_input_history(&second, 0).await.unwrap().unwrap();
    assert_eq!(entry["text"], "second prompt");
    assert_eq!(entry["attachments"][0]["path"], "notes.md");
    // 读取使用同一 identity key：前一条在另一个 identity 里不存在。
    assert!(db.recall_input_history(&first, 1).await.unwrap().is_none());

    // 重新打开同一数据库（重启）后仍可读，且 scope 不变。
    drop(db);
    let reopened = store(&dir).await;
    let entry = reopened
        .recall_input_history(&second, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry["text"], "second prompt");
    assert!(
        reopened
            .recall_input_history("remote://host/workspace/other", 0)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_failed_commit_leaves_no_history_only_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(&dir).await;
    let workspace = "/tmp/history-rollback";
    let mut s = accepted(
        session("sess_1", workspace),
        "hist_1",
        workspace,
        "lost prompt",
        None,
    );
    // 回滚中的非法 rewind 让整个事务失败：历史不能单独留下。
    s.node.push(
        3,
        Op::Rewind {
            target: "missing".into(),
            anchor: "missing".into(),
        },
    );
    assert!(
        db.commit(workspace, Some(&mut s), Some(("ack".into(), json!(1))))
            .await
            .is_err()
    );
    assert!(
        db.recall_input_history(workspace, 0)
            .await
            .unwrap()
            .is_none()
    );
    let conn = rusqlite::Connection::open(dir.path().join("db/db.sqlite")).unwrap();
    let rows: i64 = conn
        .query_row("select count(*) from input_history", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn history_dedupes_the_latest_entry_and_keeps_one_hundred_rows() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(&dir).await;
    let workspace = "/tmp/history-cap";
    let scope = crate::node::input_history::scope(workspace);
    let attachments = Some(json!([{"type":"file","path":"a.md"}]));
    let mut s = accepted(
        session("sess_1", workspace),
        "hist_1",
        workspace,
        "same prompt",
        attachments.clone(),
    );
    // 同正文同附件的第二次提交是重复项；附件不同才是新的历史。
    s.node_input_history(3, history("hist_2", workspace, "same prompt", attachments));
    s.node_input_history(
        4,
        history(
            "hist_3",
            workspace,
            "same prompt",
            Some(json!([{"type":"file","path":"b.md"}])),
        ),
    );
    db.commit(workspace, Some(&mut s), None).await.unwrap();
    let latest = db
        .recall_input_history(workspace, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(latest["attachments"][0]["path"], "b.md");
    assert_eq!(
        db.recall_input_history(workspace, 1)
            .await
            .unwrap()
            .unwrap()["text"],
        "same prompt"
    );
    assert!(
        db.recall_input_history(workspace, 2)
            .await
            .unwrap()
            .is_none()
    );

    // 既有上限不变：整表只保留最新 100 条。
    let conn = rusqlite::Connection::open(dir.path().join("db/db.sqlite")).unwrap();
    for n in 0..150 {
        crate::node::input_history::record(
            &conn,
            &format!("cap_{n}"),
            &scope,
            Some("sess_1"),
            &format!("prompt {n}"),
            None,
            "prompt",
            10 + n,
        )
        .unwrap();
    }
    let rows: i64 = conn
        .query_row("select count(*) from input_history", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 100);
    let oldest = db.recall_input_history(workspace, 99).await.unwrap();
    // 上限丢最新之外的旧行：150 条新记录后最新 100 条是 prompt 149..50。
    assert_eq!(oldest.unwrap()["text"], "prompt 50");
    assert!(
        db.recall_input_history(workspace, 100)
            .await
            .unwrap()
            .is_none()
    );
}
