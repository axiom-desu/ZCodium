// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! NodeStore over a temporary Node database: settings under Node's project
//! ids, commits that keep failed writes, and the listing and index reads.
use super::NodeStore;
use crate::contract::SessionStore;
use crate::domain::node_journal::{Admission, CompactStart};
use crate::domain::session::Session;
use crate::domain::session_listing::ListParams;
use serde_json::json;

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

fn session(workspace: &str) -> Session {
    let mut s = Session::new(
        "sess_1".into(),
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

#[tokio::test]
async fn project_settings_use_nodes_project_ids() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir).await;
    let ruleset = json!({"version": 1, "allow": [{"toolName": "Write"}]});
    store
        .save_project_setting("/", "permission", "ruleset", &ruleset)
        .await
        .unwrap();
    store
        .save_project_setting("/", "permission", "mode", &json!({"mode": "edit"}))
        .await
        .unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("db/db.sqlite")).unwrap();
    // 规则由 core 的 projectIdFromDirectory 写入（空 slug 为 session），模式由 bootstrap 写入（default）。
    let scopes: Vec<(String, String)> = conn
        .prepare("select scope_id, key from local_setting order by key")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        scopes,
        [
            ("proj_default".into(), "mode".into()),
            ("proj_session".into(), "ruleset".into())
        ]
    );
    let settings = store.project_settings("/").await.unwrap();
    assert_eq!(settings[&("permission".into(), "ruleset".into())], ruleset);
    assert_eq!(
        settings[&("permission".into(), "mode".into())],
        json!({"mode": "edit"})
    );
    assert!(
        store
            .save_project_setting("/", "other", "key", &json!(1))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_failed_commit_keeps_the_writes_and_a_later_commit_applies_them() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir).await;
    let mut s = session("/w");
    // 会话行尚未写入时账本外键失败：待写记录必须留在会话上，不能丢。
    let admission = |s: &mut Session| {
        s.node_admit_input(
            5,
            Admission {
                queue_id: "queue_c1",
                kind: "sendText",
                payload: json!({"text": "hi", "intent": {"sourceCommandId": "c1"}}),
                delivery: "startNow",
            },
        )
    };
    admission(&mut s);
    assert!(store.commit("/w", Some(&mut s), None).await.is_err());
    assert_eq!(s.node.pending.len(), 1);
    let pending = s.node.take();
    s.node_ensure_created(5, "hi", "0.0.0");
    s.node.pending.extend(pending);
    store.commit("/w", Some(&mut s), None).await.unwrap();
    assert!(s.node.pending.is_empty());
    let ack = store
        .lookup_ack_live("/w", r#"["sess_1","c1"]"#, false)
        .await
        .unwrap();
    // 未提升的输入在冷查询时按重启丢弃结算（Node discardAdmittedOnLoad）。
    assert_eq!(
        ack.unwrap()["reasonCode"],
        "fault.command.inputDiscardedOnRestart"
    );
}

#[tokio::test]
async fn snapshot_read_does_not_recover_admission_or_interrupted_compaction() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir).await;
    let mut s = session("/w");
    s.node_ensure_created(1, "hi", "0.0.0");
    s.node_compact_started(
        2,
        CompactStart {
            ids: ("cmp_1".into(), "msg_1".into(), "part_1".into()),
            trigger: "manual",
            source_command: None,
            pre_tokens: 100,
            custom_instructions: false,
        },
    );
    s.node_admit_input(
        3,
        Admission {
            queue_id: "queue_cold",
            kind: "sendText",
            payload: json!({"text":"pending", "intent":{"sourceCommandId":"cold"}}),
            delivery: "startNow",
        },
    );
    store.commit("/w", Some(&mut s), None).await.unwrap();

    let count = |sql: &str| -> i64 {
        rusqlite::Connection::open(dir.path().join("db/db.sqlite"))
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    };
    let rows = |sql: &str| -> Vec<String> {
        let conn = rusqlite::Connection::open(dir.path().join("db/db.sqlite")).unwrap();
        conn.prepare(sql)
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let ledger_before = rows(
        "select json_object('id', id, 'session_id', session_id, 'kind', kind, 'delivery', delivery, 'payload', payload, 'admitted_sequence', admitted_sequence, 'promoted_sequence', promoted_sequence, 'promoted_message_id', promoted_message_id, 'status', status, 'status_reason', status_reason, 'time_created', time_created, 'time_updated', time_updated) from session_input order by id",
    );
    let compact_before = rows(
        "select json_object('id', id, 'data', data) from part where json_extract(data, '$.type')='timeline' order by id",
    );
    let before = store.read_session("/w", "sess_1").await.unwrap().unwrap();
    assert_eq!(
        count("select count(*) from session_input where status='admitted'"),
        1
    );
    assert_eq!(
        count(
            "select count(*) from part where json_extract(data, '$.type')='timeline' and json_extract(data, '$.status')='started'"
        ),
        1
    );
    assert!(before.node.compaction.is_none());
    assert_eq!(
        rows(
            "select json_object('id', id, 'session_id', session_id, 'kind', kind, 'delivery', delivery, 'payload', payload, 'admitted_sequence', admitted_sequence, 'promoted_sequence', promoted_sequence, 'promoted_message_id', promoted_message_id, 'status', status, 'status_reason', status_reason, 'time_created', time_created, 'time_updated', time_updated) from session_input order by id"
        ),
        ledger_before
    );
    assert_eq!(
        rows(
            "select json_object('id', id, 'data', data) from part where json_extract(data, '$.type')='timeline' order by id"
        ),
        compact_before
    );

    let recovered = store.load_session("/w", "sess_1").await.unwrap().unwrap();
    assert_eq!(
        count("select count(*) from session_input where status='admitted'"),
        0
    );
    assert_eq!(
        count(
            "select count(*) from part where json_extract(data, '$.type')='timeline' and json_extract(data, '$.status')='started'"
        ),
        0
    );
    assert_eq!(recovered.messages, before.messages);
}

#[tokio::test]
async fn ack_lookup_is_scoped_to_workspace_identity_before_ledger_access() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir).await;
    for (id, workspace, path, command) in [
        (
            "remote_a",
            "remote:ssh:host:22:user:/same",
            "/same",
            "remote_ack",
        ),
        ("local_a", "/local-a", "/local-a", "local_ack"),
    ] {
        let mut s = Session::new(
            id.into(),
            workspace.into(),
            "p".into(),
            "m".into(),
            "high".into(),
            "e".into(),
            1,
        );
        s.workspace_path = Some(path.into());
        s.node_ensure_created(1, "hi", "0.0.0");
        s.node_admit_input(
            2,
            Admission {
                queue_id: &format!("queue_{command}"),
                kind: "sendText",
                payload: json!({"text":"pending", "intent":{"sourceCommandId":command}}),
                delivery: "queue",
            },
        );
        store.commit(workspace, Some(&mut s), None).await.unwrap();
    }
    let ledger = || -> Vec<String> {
        let conn = rusqlite::Connection::open(dir.path().join("db/db.sqlite")).unwrap();
        conn.prepare("select json_object('id', id, 'session_id', session_id, 'kind', kind, 'delivery', delivery, 'payload', payload, 'admitted_sequence', admitted_sequence, 'promoted_sequence', promoted_sequence, 'promoted_message_id', promoted_message_id, 'status', status, 'status_reason', status_reason, 'time_created', time_created, 'time_updated', time_updated) from session_input order by id").unwrap()
            .query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    let before = ledger();
    assert!(
        store
            .lookup_ack(
                "remote:ssh:other:22:user:/same",
                r#"["remote_a","remote_ack"]"#
            )
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(ledger(), before);
    assert!(
        store
            .lookup_ack("/local-b", r#"["local_a","local_ack"]"#)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(ledger(), before);
    assert_eq!(
        store
            .lookup_ack(
                "remote:ssh:host:22:user:/same",
                r#"["remote_a","remote_ack"]"#
            )
            .await
            .unwrap()
            .unwrap()["status"],
        "failed"
    );
    assert_eq!(
        store
            .lookup_ack("/local-a", r#"["local_a","local_ack"]"#)
            .await
            .unwrap()
            .unwrap()["status"],
        "failed"
    );
}

#[tokio::test]
async fn listing_and_index_read_node_session_rows() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(&dir).await;
    let mut s = session("/w");
    s.node_ensure_created(7, "Hello   there", "0.0.0");
    store.commit("/w", Some(&mut s), None).await.unwrap();
    let index = store.load_index("/w").await.unwrap();
    assert_eq!(index["sess_1"]["title"], "Hello there");
    assert_eq!(index["sess_1"]["titleSource"], "generated");
    assert!(store.load_index("/other").await.unwrap().is_empty());
    let listed = store
        .list_sessions(&ListParams::default(), ("/w", "/w"))
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    let projected = listed[0].projection(None);
    assert_eq!(
        projected["workspace"],
        json!({"workspacePath": "/w", "workspaceKey": "/w"})
    );
    assert_eq!(projected["titleSource"], "first_input");
    let loaded = store.load_session("/w", "sess_1").await.unwrap().unwrap();
    assert!(loaded.node.created);
    assert_eq!(loaded.title, "Hello there");
    assert!(
        store
            .load_session("/other", "sess_1")
            .await
            .unwrap()
            .is_none()
    );
    store.discard_draft("/w", "sess_2", None).await.unwrap();
    assert!(store.load("/w").await.is_err());
}
