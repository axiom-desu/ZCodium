//! `session/list` ownership proofs for explicit session IDs (Node
//! `listSessions`):持久 parentID 是辅助子会话归属的唯一证据。
use super::{listing, open, sessions};
use rusqlite::Connection;
use serde_json::{Value, json};
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

/// `workspace_id = None` 表示该行只有 cwd/path（子 runtime 落库的典型形态）。
fn create(
    conn: &Connection,
    id: &str,
    kind: &str,
    parent: Option<&str>,
    path: &str,
    identity: Option<&str>,
) {
    let input = sessions::Create {
        id: id.into(),
        project_id: "proj".into(),
        workspace_id: identity.map(str::to_owned),
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

fn params(workspace: Value, session_ids: Option<Vec<&str>>) -> ListParams {
    let mut value = json!({"workspace": workspace});
    if let Some(ids) = session_ids {
        value["sessionIds"] = json!(ids);
    }
    ListParams::parse(&value).unwrap()
}

fn local(path: &str) -> Value {
    json!({"workspacePath": path, "workspaceKey": path})
}

fn ids(conn: &Connection, params: &ListParams) -> Vec<String> {
    listing::rows(conn, params)
        .unwrap()
        .into_iter()
        .map(|row| row.id)
        .collect()
}

/// 远端 workspace：key 是 identity，path 仍是执行路径。子 runtime 落库的历史行只有 cwd，
/// 只有父链能证明它属于这个远端任务。
fn remote(path: &str, identity: &str) -> Value {
    json!({"workspacePath": path, "workspaceKey": identity, "workspaceIdentity": identity})
}

#[test]
fn an_auxiliary_child_is_owned_by_its_persisted_parent_chain() {
    let (_dir, conn) = migrated();
    create(
        &conn,
        "root",
        "interactive",
        None,
        "/w",
        Some("remote:ssh:h:/w"),
    );
    for kind in [
        "workflow_child",
        "nested_workflow_child",
        "subagent_child",
        "selection_side_chat",
    ] {
        create(&conn, kind, kind, Some("root"), "/w", None);
        // 显式 ID 查询凭父链归入远端 workspace；普通分页仍只按 key 过滤。
        assert_eq!(
            ids(
                &conn,
                &params(remote("/w", "remote:ssh:h:/w"), Some(vec![kind]))
            ),
            [kind.to_owned()],
            "{kind}"
        );
        // 普通分页仍按 workspace key 隔离，不凭父链把只有 cwd 的辅助子会话拉进来。
        assert_eq!(
            ids(&conn, &params(remote("/w", "remote:ssh:h:/w"), None)),
            ["root"],
            "{kind}"
        );
    }
}

#[test]
fn a_cross_workspace_or_identity_conflicting_chain_is_rejected() {
    let (_dir, conn) = migrated();
    // 父行路径不同 → 拒绝（不能把同 identity 的另一路径行拉进来）。
    create(
        &conn,
        "other_root",
        "interactive",
        None,
        "/other",
        Some("remote:ssh:h:/w"),
    );
    create(
        &conn,
        "child",
        "workflow_child",
        Some("other_root"),
        "/w",
        None,
    );
    assert!(
        ids(
            &conn,
            &params(remote("/w", "remote:ssh:h:/w"), Some(vec!["child"]))
        )
        .is_empty()
    );
    // 子行显式身份与自己的 path 冲突（同路径不同 authority）→ 拒绝，不上溯。
    create(
        &conn,
        "foreign_root",
        "interactive",
        None,
        "/w",
        Some("remote:ssh:h:/w"),
    );
    create(
        &conn,
        "foreign",
        "workflow_child",
        Some("foreign_root"),
        "/w",
        Some("remote:ssh:x:/w"),
    );
    assert!(
        ids(
            &conn,
            &params(remote("/w", "remote:ssh:h:/w"), Some(vec!["foreign"]))
        )
        .is_empty()
    );
}

#[test]
fn independent_kinds_never_walk_the_parent_chain() {
    let (_dir, conn) = migrated();
    create(
        &conn,
        "root",
        "interactive",
        None,
        "/w",
        Some("remote:ssh:h:/w"),
    );
    // fork / workflow_parent 是独立任务：即使带 parentID 也不能沿父链改写项目归属。
    for kind in ["fork", "workflow_parent"] {
        create(&conn, kind, kind, Some("root"), "/w", None);
        assert!(
            ids(
                &conn,
                &params(remote("/w", "remote:ssh:h:/w"), Some(vec![kind]))
            )
            .is_empty(),
            "{kind}"
        );
        // 它们自己的 key 就是本地路径，所以在本地 workspace 分页里正常出现。
        assert_eq!(
            ids(&conn, &params(local("/w"), Some(vec![kind]))),
            [kind.to_owned()]
        );
    }
}

#[test]
fn deleted_rows_are_rejected_at_every_chain_level() {
    let (_dir, conn) = migrated();
    create(
        &conn,
        "root",
        "interactive",
        None,
        "/w",
        Some("remote:ssh:h:/w"),
    );
    create(&conn, "child", "workflow_child", Some("root"), "/w", None);
    let page = params(remote("/w", "remote:ssh:h:/w"), Some(vec!["child"]));
    assert_eq!(ids(&conn, &page), ["child"]);
    sessions::soft_delete(&conn, "root", 5_000).unwrap();
    // 父已删除：归属证明断链，不能凭已删行继续上溯。
    assert!(ids(&conn, &page).is_empty());
    // 已删除行自身也永不返回（含显式 ID 查询）。
    assert!(
        ids(
            &conn,
            &params(remote("/w", "remote:ssh:h:/w"), Some(vec!["root"]))
        )
        .is_empty()
    );
}

#[test]
fn a_plain_page_still_uses_the_workspace_key_only() {
    let (_dir, conn) = migrated();
    create(&conn, "mine", "interactive", None, "/w", None);
    create(
        &conn,
        "theirs",
        "interactive",
        None,
        "/w",
        Some("remote:ssh:h:/w"),
    );
    // 普通分页按 workspace key 隔离：同路径不同 identity 不会互相串。
    assert_eq!(ids(&conn, &params(local("/w"), None)), ["mine"]);
    assert_eq!(
        ids(&conn, &params(remote("/w", "remote:ssh:h:/w"), None)),
        ["theirs"]
    );
}
