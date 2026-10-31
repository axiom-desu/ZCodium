//! `v4/sessionsIndex/reconcile` cross-engine facts: alive/soft-deleted/foreign
//! path/remote identity and absence (never a paging or epoch deletion).
use crate::node::reconcile;
use crate::node::{open, sessions};
use rusqlite::Connection;
use serde_json::json;

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

fn create(
    conn: &Connection,
    id: &str,
    directory: &str,
    identity: Option<&str>,
    title: &str,
    source: &str,
) {
    let input = sessions::Create {
        id: id.into(),
        project_id: "proj".into(),
        workspace_id: identity.map(str::to_owned),
        task_type: Some("interactive".into()),
        slug: id.into(),
        directory: directory.into(),
        path: Some(directory.into()),
        title: title.into(),
        title_source: Some(source.into()),
        version: "0.0.0".into(),
        ..Default::default()
    };
    sessions::create(conn, &input, 1_000).unwrap();
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|id| (*id).to_owned()).collect()
}

#[test]
fn alive_deleted_foreign_and_missing_are_distinct_facts() {
    let (_dir, conn) = migrated();
    create(&conn, "kept", "/w", None, "Kept", "custom");
    create(&conn, "removed", "/w", None, "Gone", "generated");
    create(&conn, "other", "/elsewhere", None, "Other", "generated");
    sessions::soft_delete(&conn, "removed", 5_000).unwrap();
    conn.execute(
        "update session set last_outcome='error' where id='kept'",
        [],
    )
    .unwrap();

    let result =
        reconcile::sessions(&conn, "/w", &ids(&["kept", "removed", "other", "missing"])).unwrap();
    assert_eq!(
        result,
        json!({"sessions": [
            {"sessionId":"kept","exists":true,"deleted":false,"title":"Kept",
             "titleSource":"custom","createdAt":1000,"updatedAt":1000,"lastOutcome":"error"},
            {"sessionId":"removed","exists":true,"deleted":true,"title":"Gone",
             "titleSource":"generated","createdAt":1000,"updatedAt":1000},
            {"sessionId":"other","exists":false,"deleted":false},
            {"sessionId":"missing","exists":false,"deleted":false}
        ]})
    );
}

#[test]
fn remote_identity_matches_only_its_own_workspace_id() {
    let (_dir, conn) = migrated();
    let identity = "remote:ssh:example.test:22:user:/repo";
    create(&conn, "local", "/repo", None, "local", "generated");
    create(
        &conn,
        "remote",
        "/repo",
        Some(identity),
        "remote",
        "generated",
    );
    let result = reconcile::sessions(&conn, identity, &ids(&["local", "remote"])).unwrap();
    assert_eq!(
        result,
        json!({"sessions": [
            {"sessionId":"local","exists":false,"deleted":false},
            {"sessionId":"remote","exists":true,"deleted":false,"title":"remote",
             "titleSource":"generated","createdAt":1000,"updatedAt":1000}
        ]})
    );
}

#[test]
fn unknown_last_outcome_reads_as_absent_like_the_node_codec() {
    let (_dir, conn) = migrated();
    create(&conn, "s1", "/w", None, "s1", "generated");
    conn.execute("update session set last_outcome='future' where id='s1'", [])
        .unwrap();
    let result = reconcile::sessions(&conn, "/w", &ids(&["s1"])).unwrap();
    assert!(result["sessions"][0].get("lastOutcome").is_none());
}
