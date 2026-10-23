//! Soft deletion and `lastOutcome` persistence over the real Node schema
//! (migration 0023). Sibling fixture replays live in `session_tests.rs`.
use super::{listing, messages, open, sessions};
use rusqlite::Connection;
use serde_json::json;
use zcode_cli_domain::session_listing::ListParams;

fn migrated() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let conn = open::open(
        &dir.path().join("db.sqlite"),
        open::MIGRATION_LOCK_WAIT,
        &mut |_| {},
    )
    .unwrap();
    (dir, conn)
}

fn create(conn: &Connection, id: &str, kind: &str, parent: Option<&str>, path: &str) {
    let input = sessions::Create {
        id: id.into(),
        project_id: "w".into(),
        parent_id: parent.map(str::to_owned),
        task_type: Some(kind.into()),
        slug: id.into(),
        directory: path.into(),
        path: Some(path.into()),
        title: id.into(),
        version: "0.0.0".into(),
        ..Default::default()
    };
    sessions::create(conn, &input, 1_000).unwrap();
}

fn ids(conn: &Connection, params: &ListParams) -> Vec<String> {
    listing::rows(conn, params)
        .unwrap()
        .into_iter()
        .map(|row| row.id)
        .collect()
}

fn listing_params(workspace: &str, session_ids: Option<Vec<&str>>) -> ListParams {
    let mut params = json!({"workspace": {"workspacePath": workspace, "workspaceKey": workspace}});
    if let Some(ids) = session_ids {
        params["sessionIds"] = json!(ids);
    }
    ListParams::parse(&params).unwrap()
}

#[test]
fn soft_delete_keeps_the_first_time_and_hides_the_row_from_lists() {
    let (_dir, conn) = migrated();
    create(&conn, "s1", "interactive", None, "/w");
    create(&conn, "s2", "interactive", None, "/w");
    assert_eq!(sessions::soft_delete(&conn, "s1", 5_000).unwrap(), 1);
    assert_eq!(sessions::soft_delete(&conn, "s1", 9_000).unwrap(), 1);
    let row = sessions::get(&conn, "s1").unwrap().unwrap();
    assert_eq!(row.time_deleted, Some(5_000));
    assert!(!sessions::visible(&row));
    // getSession 仍返回软删行；普通列表与显式 ID 查询都不返回。
    assert_eq!(ids(&conn, &listing_params("/w", None)), ["s2"]);
    assert_eq!(
        ids(&conn, &listing_params("/w", Some(vec!["s1"]))),
        Vec::<String>::new()
    );
}

#[test]
fn soft_delete_keeps_bodies_and_the_upsert_never_resurrects() {
    let (_dir, conn) = migrated();
    create(&conn, "s1", "interactive", None, "/w");
    messages::save_message(
        &conn,
        &json!({"id": "m1", "sessionID": "s1", "role": "user", "time": {"created": 1_000}}),
        None,
        1_000,
    )
    .unwrap();
    sessions::soft_delete(&conn, "s1", 5_000).unwrap();
    // 正文保留。
    let rows: i64 = conn
        .query_row(
            "select count(*) from message where session_id = 's1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1);
    // Node `createSession` 的 upsert 不写 time_deleted：删除行不会复活。
    create(&conn, "s1", "interactive", None, "/w");
    let row = sessions::get(&conn, "s1").unwrap().unwrap();
    assert_eq!(row.time_deleted, Some(5_000));
    assert_eq!(row.title, "s1");
    assert!(ids(&conn, &listing_params("/w", None)).is_empty());
}

#[test]
fn last_outcome_round_trips_and_unknown_values_read_as_absent() {
    let (_dir, conn) = migrated();
    create(&conn, "s1", "interactive", None, "/w");
    for outcome in sessions::LAST_OUTCOMES {
        let update = sessions::Update {
            id: "s1".into(),
            last_outcome: Some(outcome.into()),
            time_updated: Some(4_000),
            ..Default::default()
        };
        let row = sessions::update(&conn, &update, 4_000).unwrap();
        assert_eq!(row.last_outcome.as_deref(), Some(outcome));
        // 只写本次输入拥有的列：标题/活动时间不被整行快照覆盖。
        assert_eq!((row.title.as_str(), row.time_updated), ("s1", 4_000));
    }
    conn.execute("update session set last_outcome = 'cancelled_by_user'", [])
        .unwrap();
    assert_eq!(
        sessions::get(&conn, "s1").unwrap().unwrap().last_outcome,
        None
    );
}

#[test]
fn a_deleted_session_cannot_be_resumed() {
    let (_dir, conn) = migrated();
    create(&conn, "s1", "interactive", None, "/w");
    assert!(
        super::resume::resume(&conn, "s1", &|_| None, None)
            .unwrap()
            .is_some()
    );
    sessions::soft_delete(&conn, "s1", 5_000).unwrap();
    assert!(
        super::resume::resume(&conn, "s1", &|_| None, None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn stored_summary_exposes_the_durable_last_outcome() {
    let (_dir, conn) = migrated();
    create(&conn, "s1", "interactive", None, "/w");
    sessions::update(
        &conn,
        &sessions::Update {
            id: "s1".into(),
            last_outcome: Some("interrupted".into()),
            time_updated: Some(4_000),
            ..Default::default()
        },
        4_000,
    )
    .unwrap();
    let summaries = listing::stored_summaries(&conn, "/w").unwrap();
    assert_eq!(summaries[0]["phase"], "completedInterrupted");
    assert_eq!(summaries[0]["lastOutcome"], "interrupted");
}
