use super::*;
use std::sync::mpsc;

fn open_at(path: &Path, wait: Duration) -> (Result<Connection, StartupError>, Vec<Progress>) {
    let mut seen = vec![];
    let result = open(path, wait, &mut |p| seen.push(p.clone()));
    (result, seen)
}

fn ledger(conn: &Connection) -> Vec<(String, String, String)> {
    conn.prepare("select id, checksum, app_version from schema_migration order by id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn a_new_database_gets_every_node_migration_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let (conn, progress) = open_at(&path, MIGRATION_LOCK_WAIT);
    let conn = conn.unwrap();
    let rows = ledger(&conn);
    assert_eq!(rows.len(), MIGRATIONS.len());
    for (row, migration) in rows.iter().zip(&MIGRATIONS) {
        assert_eq!(row.0, migration.id);
        assert_eq!(row.1, checksum(migration.sql));
        assert_eq!(row.2, migration.app_version);
    }
    let mode: String = conn
        .query_row("pragma journal_mode", [], |r| r.get(0))
        .unwrap();
    let keys: i64 = conn
        .query_row("pragma foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!((mode.as_str(), keys), ("wal", 1));
    let phases: Vec<&Phase> = progress.iter().map(|p| &p.phase).collect();
    assert_eq!(phases.first(), Some(&&Phase::Checking));
    assert_eq!(
        phases
            .iter()
            .filter(|p| matches!(p, Phase::Migrating { .. }))
            .count(),
        MIGRATIONS.len()
    );
    let last = progress.last().unwrap();
    assert_eq!(last.phase, Phase::Ready);
    let facts = last.facts.clone().unwrap();
    assert_eq!(
        (
            facts.kind,
            facts.executed,
            facts.committed,
            facts.last_applied
        ),
        ("initialize", 23, 23, Some(None))
    );
    drop(conn);

    let (conn, progress) = open_at(&path, MIGRATION_LOCK_WAIT);
    conn.unwrap();
    let facts = progress.last().unwrap().facts.clone().unwrap();
    assert_eq!((facts.kind, facts.executed), ("none", 0));
    assert_eq!(
        facts.last_applied,
        Some(Some("0023_session_soft_delete_outcome".into()))
    );
}

#[test]
fn foreign_migrations_tables_and_columns_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    open_at(&path, MIGRATION_LOCK_WAIT).0.unwrap();
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "insert into schema_migration values ('0024_todo_state_revision','y','0.15.2',1);
             create table todo_state(session_id text primary key, todo_revision integer not null, time_updated integer not null);",
        )
        .unwrap();
    }
    let (_conn, progress) = open_at(&path, MIGRATION_LOCK_WAIT);
    assert!(progress.last().unwrap().facts.is_some());
    assert_eq!(progress.last().unwrap().facts.clone().unwrap().kind, "none");
}

#[test]
fn a_ledger_gap_is_filled_without_rerunning_existing_columns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    open_at(&path, MIGRATION_LOCK_WAIT).0.unwrap();
    {
        // 另一实现（或上游 ZCode）先加过这两列、却没有本仓的 0023 账本行：
        // 重复 alter 必须是幂等的，否则整库启动失败。
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "delete from schema_migration where id = '0023_session_soft_delete_outcome';",
        )
        .unwrap();
    }
    let (conn, progress) = open_at(&path, MIGRATION_LOCK_WAIT);
    let conn = conn.unwrap();
    let facts = progress.last().unwrap().facts.clone().unwrap();
    assert_eq!((facts.kind, facts.executed), ("upgrade", 1));
    let applied: String = conn
        .query_row(
            "select checksum from schema_migration where id = '0023_session_soft_delete_outcome'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        applied,
        checksum(MIGRATIONS.last().unwrap().sql),
        "0023 ledger row keeps the shared checksum"
    );
    let columns: i64 = conn
        .query_row(
            "select count(*) from pragma_table_info('session') where name in ('time_deleted','last_outcome')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(columns, 2);
}

#[test]
fn a_changed_checksum_stops_startup_and_a_gap_is_filled() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    open_at(&path, MIGRATION_LOCK_WAIT).0.unwrap();
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "delete from schema_migration where id = '0022_backfilled_session_reasoning'",
        [],
    )
    .unwrap();
    let (reopened, progress) = open_at(&path, MIGRATION_LOCK_WAIT);
    reopened.unwrap();
    let facts = progress.last().unwrap().facts.clone().unwrap();
    assert_eq!((facts.kind, facts.executed), ("upgrade", 1));

    conn.execute(
        "update schema_migration set checksum = 'x' where id = '0005_session_target_accounting'",
        [],
    )
    .unwrap();
    let error = open_at(&path, MIGRATION_LOCK_WAIT).0.unwrap_err();
    assert_eq!(error.code, "checksum_mismatch");
    assert_eq!(error.migration_id, Some("0005_session_target_accounting"));
}

#[test]
fn another_writer_makes_startup_wait_or_time_out() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    open_at(&path, MIGRATION_LOCK_WAIT).0.unwrap();
    let holder = Connection::open(&path).unwrap();
    holder.execute_batch("begin immediate").unwrap();
    // 与 Node 相同，先判截止再报告等待；150 ms 预算在全量并行测试下可能在首次 BUSY 前耗尽，
    // 导致从未报告 WaitingForLock。放宽到 1 s 保证首次 BUSY 落在截止之前。
    let (result, progress) = open_at(&path, Duration::from_secs(1));
    let error = result.unwrap_err();
    assert_eq!(error.code, "lock_timeout");
    assert!(progress.iter().any(|p| p.phase == Phase::WaitingForLock));

    let (release, released) = mpsc::channel();
    let waiter = {
        let path = path.clone();
        std::thread::spawn(move || {
            let (result, _) = open_at(&path, Duration::from_secs(5));
            release.send(()).ok();
            result.map(drop)
        })
    };
    std::thread::sleep(Duration::from_millis(100));
    holder.execute_batch("commit").unwrap();
    waiter.join().unwrap().unwrap();
    released.recv().unwrap();
}

/// 半升级库：0023 只加过一列、账本行缺失（崩溃在两条 ALTER 之间，或另一个实现只认识其中一列）。
/// Node `0023-…ts` 的 `apply` 逐列判存在，Rust 必须同样只为缺失列执行 ALTER，
/// 否则 duplicate column name 会让这个库永久无法启动（两侧共用同一个 SQLite 账本）。
#[test]
fn a_ledger_gap_with_one_present_column_adds_only_the_missing_one() {
    for (present, missing) in [
        ("time_deleted", "last_outcome"),
        ("last_outcome", "time_deleted"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        open_at(&path, MIGRATION_LOCK_WAIT).0.unwrap();
        {
            conn_fixture(&path, present, missing);
        }
        let (conn, progress) = open_at(&path, MIGRATION_LOCK_WAIT);
        let conn = conn.unwrap_or_else(|error| {
            panic!("只存在 {present} 的历史库必须能启动，实际 {error}");
        });
        let facts = progress.last().unwrap().facts.clone().unwrap();
        assert_eq!((facts.kind, facts.executed), ("upgrade", 1));
        for column in ["time_deleted", "last_outcome"] {
            let exists: i64 = conn
                .query_row(
                    "select count(*) from pragma_table_info('session') where name = ?",
                    [column],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                exists, 1,
                "{column} 必须存在（{present} 已存在，缺 {missing}）"
            );
        }
        // 账本 checksum 仍是共享 0023 SQL 的整段值：TS/Rust 互认。
        let applied: String = conn
            .query_row(
                "select checksum from schema_migration where id = '0023_session_soft_delete_outcome'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(applied, checksum(MIGRATIONS.last().unwrap().sql));
    }
}

/// 造出「只存在一列、0023 账本行缺失」的历史库。
fn conn_fixture(path: &Path, present: &str, missing: &str) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!(
        "delete from schema_migration where id = '0023_session_soft_delete_outcome';
         alter table session drop column {missing};"
    ))
    .unwrap();
    let exists: i64 = conn
        .query_row(
            "select count(*) from pragma_table_info('session') where name = ?",
            [present],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1, "fixture 必须保留 {present}");
}
