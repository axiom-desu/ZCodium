// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! 永久删除的真实 SQLite 事实：owned tree、引用保留、跨进程运行态、事务锁与断点重试。
use super::{open, session_data, session_data_files, session_data_inspect};
use rusqlite::{Connection, params};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

/// 平台目录链接原语：unix `symlink`，Windows `symlink_dir`；其它平台返回 `None`。
/// 存储类别目录被换成链接必须拒绝清理的安全断言由平台自己的真实原语构造，
/// 不能用 `std::os::unix::fs::symlink` 直写（那会让 Windows `--all-targets` 编译失败）。
#[cfg(any(unix, windows))]
fn link_directory(target: &Path, link: &Path) -> Option<std::io::Result<()>> {
    #[cfg(unix)]
    return Some(std::os::unix::fs::symlink(target, link));
    #[cfg(windows)]
    return Some(std::os::windows::fs::symlink_dir(target, link));
}

#[cfg(not(any(unix, windows)))]
fn link_directory(_target: &Path, _link: &Path) -> Option<std::io::Result<()>> {
    None
}

fn database() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let conn = open::open(
        &dir.path().join("db.sqlite"),
        open::MIGRATION_LOCK_WAIT,
        &mut |_| {},
    )
    .unwrap();
    for (id, parent, kind) in [
        ("root", None, "interactive"),
        ("child", Some("root"), "subagent_child"),
        ("fork", Some("root"), "interactive"),
    ] {
        conn.execute(
            "insert into session(id,project_id,parent_id,task_type,slug,directory,title,version,time_created,time_updated)
             values(?,?,?,?,?,?,?,?,1,1)",
            params![id, "project", parent, kind, id, "/work/example", id, "1"],
        )
        .unwrap();
    }
    (dir, conn)
}

fn insert_part(conn: &Connection, id: &str, session: &str, uri: &str) {
    conn.execute(
        "insert into message(id,session_id,time_created,time_updated,data) values(?,?,1,1,'{}')",
        params![format!("m-{id}"), session],
    )
    .unwrap();
    conn.execute(
        "insert into part(id,message_id,session_id,time_created,time_updated,data) values(?,?,?,1,1,?)",
        params![
            id,
            format!("m-{id}"),
            session,
            serde_json::json!({"url": uri}).to_string()
        ],
    )
    .unwrap();
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn owned_tree_excludes_fork_and_referenced_artifacts_are_reported() {
    let (_dir, conn) = database();
    insert_part(&conn, "part", "fork", "zcode-artifact://root/shared");
    let trees = session_data::owned_trees(&conn, &["root".to_owned()]).unwrap();
    assert_eq!(trees["root"], vec!["child".to_owned(), "root".to_owned()]);
    let referrers = session_data::artifact_referrers(&conn, &["root".to_owned()]).unwrap();
    assert_eq!(referrers["root"], vec!["fork".to_owned()]);

    let snapshot = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
    assert_eq!(strings(&snapshot["sessionIds"]), vec!["child", "root"]);
    assert_eq!(snapshot["forks"][0]["sessionId"], "fork");
    assert_eq!(snapshot["references"][0]["artifactId"], "shared");
    assert_eq!(
        snapshot["references"][0]["referrers"][0]["sessionId"],
        "fork"
    );
    assert_eq!(snapshot["workspacePath"], "/work/example");
    let revision = snapshot["revision"].as_str().unwrap().to_owned();

    conn.execute(
        "insert into session(id,project_id,parent_id,task_type,slug,directory,title,version,time_created,time_updated)
         values('late','project','root','subagent_child','late','/work/example','late','1',1,1)",
        [],
    )
    .unwrap();
    let next = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
    assert_ne!(next["revision"].as_str().unwrap(), revision);
    let changed = session_data::begin(&conn, "root", "owner", &revision, "op", &[]);
    assert_eq!(changed.unwrap_err().to_string(), "session-data.changed");
}

#[test]
fn admission_guards_reject_writes_and_purge_keeps_fork() {
    let (_dir, conn) = database();
    insert_part(&conn, "part", "fork", "zcode-artifact://root/shared");
    conn.execute(
        "insert into input_history(id,project_id,session_id,text,kind,time_created) values('h','project','root','secret','prompt',1)",
        [],
    )
    .unwrap();
    let snapshot = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
    session_data::begin(
        &conn,
        "root",
        "owner",
        snapshot["revision"].as_str().unwrap(),
        "op",
        &[("root".to_owned(), "shared".to_owned())],
    )
    .unwrap();
    assert_eq!(
        session_data::register_presence(&conn, "other", "root")
            .unwrap_err()
            .to_string(),
        "session-data.deleting"
    );
    assert!(
        conn.execute(
            "insert into message(id,session_id,time_created,time_updated,data) values('late','child',1,1,'{}')",
            [],
        )
        .is_err()
    );
    assert_eq!(session_data::complete(&conn, "root").unwrap(), ());
    let gone: i64 = conn
        .query_row(
            "select count(*) from session where id in ('root','child')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(gone, 0);
    let input: i64 = conn
        .query_row("select count(*) from input_history", [], |row| row.get(0))
        .unwrap();
    assert_eq!(input, 0);
    let fork: i64 = conn
        .query_row("select count(*) from session where id='fork'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(fork, 1);
    session_data::complete(&conn, "root").unwrap();
    let after = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
    assert_eq!(after["completed"], true);
    assert_eq!(strings(&after["sessionIds"]), vec!["child", "root"]);
    assert_eq!(after["references"][0]["artifactId"], "shared");
}

#[test]
fn foreign_presence_blocks_and_dead_process_rows_are_pruned() {
    let (_dir, conn) = database();
    assert_eq!(
        session_data::register_presence(&conn, "owner", "root").unwrap(),
        ()
    );
    let snapshot = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
    assert_eq!(strings(&snapshot["localRuntimeIds"]), vec!["root"]);
    assert_eq!(snapshot["foreignRuntime"], false);

    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .unwrap();
    conn.execute(
        "insert into session_runtime_presence values('child','foreign',?)",
        params![child.id() as i64],
    )
    .unwrap();
    let blocked = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
    assert_eq!(blocked["foreignRuntime"], true);
    assert_eq!(
        session_data::begin(&conn, "root", "owner", "revision", "op", &[])
            .unwrap_err()
            .to_string(),
        "session-data.running"
    );

    child.kill().unwrap();
    child.wait().unwrap();
    if cfg!(target_os = "linux") {
        // 崩溃进程的残留运行态必须在下次预检时清除，不能永久阻止删除。
        let recovered = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
        assert_eq!(recovered["foreignRuntime"], false);
        let rows = session_data::presence_rows(&conn).unwrap();
        assert!(rows.iter().all(|(_, owner, _)| owner == "owner"));
    }
}

#[test]
fn write_lock_blocks_admission_and_completion_retries_after_files_are_gone() {
    let (dir, conn) = database();
    let root = dir.path().join("cli");
    std::fs::create_dir_all(root.join("artifacts/root")).unwrap();
    std::fs::write(root.join("artifacts/root/private.txt"), "private").unwrap();
    let path = dir.path().join("db.sqlite");
    let snapshot = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
    let revision = snapshot["revision"].as_str().unwrap().to_owned();

    // 测试用短超时：真实业务连接仍是 5s；这里只验证“锁冲突返回错误而非成功”。
    conn.busy_timeout(std::time::Duration::from_millis(50))
        .unwrap();
    let locked = Connection::open(&path).unwrap();
    locked
        .busy_timeout(std::time::Duration::from_millis(50))
        .unwrap();
    locked.execute_batch("begin immediate").unwrap();
    assert!(session_data::begin(&conn, "root", "owner", &revision, "op", &[]).is_err());
    let receipts: i64 = conn
        .query_row("select count(*) from session_purge", [], |row| row.get(0))
        .unwrap();
    assert_eq!(receipts, 0, "锁冲突不能留下半写凭据");
    locked.execute_batch("rollback").unwrap();

    session_data::begin(&conn, "root", "owner", &revision, "op", &[]).unwrap();
    // 文件删除成功、正文删除遇到锁：留下 partial 状态，凭据仍阻止复活。
    let bytes = session_data_files::remove(&root, "root", &[]).unwrap();
    assert!(bytes > 0);
    assert!(!root.join("artifacts/root/private.txt").exists());
    locked.execute_batch("begin immediate").unwrap();
    assert!(session_data::complete(&conn, "root").is_err());
    assert!(
        conn.query_row("select count(*) from session where id='root'", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
            > 0
    );
    locked.execute_batch("rollback").unwrap();
    session_data::complete(&conn, "root").unwrap();
    let snapshot = session_data_inspect::inspect(&conn, "root", "owner").unwrap();
    assert_eq!(snapshot["completed"], true);
}

#[test]
fn file_deletion_retains_referenced_artifact_and_rejects_symlink_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("cli");
    std::fs::create_dir_all(root.join("artifacts/root")).unwrap();
    std::fs::write(root.join("artifacts/root/shared.png"), "shared").unwrap();
    std::fs::write(root.join("artifacts/root/private.txt"), "private").unwrap();
    let files = session_data_files::list(&root, "root").unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|file| file["kind"] == "artifact"));

    let retained = BTreeSet::from(["shared".to_owned()]);
    let bytes =
        session_data_files::remove(&root, "root", &retained.iter().cloned().collect::<Vec<_>>())
            .unwrap();
    assert_eq!(bytes, "private".len() as u64);
    assert_eq!(
        std::fs::read_to_string(root.join("artifacts/root/shared.png")).unwrap(),
        "shared"
    );
    assert!(!root.join("artifacts/root/private.txt").exists());
    assert_eq!(session_data_files::remove(&root, "root", &[]).unwrap(), 6);
    assert_eq!(session_data_files::measure(&root, "root").unwrap(), 0);

    // 存储类别目录被换成链接时拒绝清理，不能沿祖先链接删除用户文件。
    let elsewhere = dir.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("kept.txt"), "keep").unwrap();
    if let Some(created) = link_directory(&elsewhere, &root.join("exec")) {
        created.unwrap();
        let error = session_data_files::list(&root, "root").unwrap_err();
        assert_eq!(error.to_string(), "session-data.symlink-root");
        // 拒绝必须发生在动手之前：链接目标与用户文件都还在。
        assert!(elsewhere.join("kept.txt").exists());
    }

    // 记忆目录与 Node `resolveProjectMemoryRoot` 同构：slug-hash/memory。
    let memory = session_data_files::memory_root(&root, "/work/example", None).unwrap();
    assert!(memory.to_string_lossy().contains("/memories/projects/"));
    assert!(
        memory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("example-")
    );
    assert_eq!(
        session_data_files::measure_memory(&root, "/work/example", None).unwrap(),
        0
    );
}
