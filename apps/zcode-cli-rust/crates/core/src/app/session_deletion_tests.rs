// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! `deletionPreview/Execute` 的 revision、阻塞原因与执行顺序。
use super::test_support::{Store, WORKSPACE, engine, files, snapshot};
use crate::contract::Method;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[tokio::test]
async fn preview_counts_files_and_blocks_not_found_without_zero_success() {
    let store = Arc::new(Store {
        files: files(),
        snapshot: snapshot(),
        ..Store::default()
    });
    let mut preview_engine = engine(store, &[]).await;
    let preview = preview_engine
        .session_data(
            Method::SessionDataDeletionPreview,
            &json!({"sessionId": "root", "workspace": {"workspacePath": WORKSPACE}}),
        )
        .await
        .unwrap();
    assert_eq!(preview["deletedFiles"], 2);
    assert_eq!(preview["retainedArtifacts"][0]["fileName"], "shared.png");
    assert_eq!(preview["forks"][0]["sessionId"], "fork");
    assert_eq!(preview["blockedReason"], Value::Null);

    let missing = Arc::new(Store {
        snapshot: json!({
            "workspacePath": Value::Null,
            "revision": "snapshot",
            "sessionIds": [],
            "forks": [],
            "references": [],
            "foreignRuntime": false,
            "localRuntimeIds": [],
            "pendingWork": false,
            "deleting": false,
            "completed": false,
        }),
        ..Store::default()
    });
    let mut missing_engine = engine(missing, &[]).await;
    let preview = missing_engine
        .session_data(
            Method::SessionDataDeletionPreview,
            &json!({"sessionId": "root", "workspace": {"workspacePath": WORKSPACE}}),
        )
        .await
        .unwrap();
    assert_eq!(preview["blockedReason"], "not-found");
}

#[tokio::test]
async fn execute_requires_matching_revision_then_runs_ordered_cleanup() {
    let store = Arc::new(Store {
        files: files(),
        snapshot: json!({
            "workspacePath": WORKSPACE,
            "revision": "snapshot",
            "sessionIds": ["root", "child"],
            "forks": [],
            "references": [],
            "foreignRuntime": false,
            "localRuntimeIds": [],
            "pendingWork": false,
            "deleting": false,
            "completed": false,
        }),
        sizes: BTreeMap::from([("root".into(), 10), ("child".into(), 3)]),
        ..Store::default()
    });
    let mut engine = engine(store.clone(), &[]).await;
    let preview = engine
        .session_data(
            Method::SessionDataDeletionPreview,
            &json!({"sessionId": "root", "workspace": {"workspacePath": WORKSPACE}}),
        )
        .await
        .unwrap();
    let stale = engine
        .session_data(
            Method::SessionDataDeletionExecute,
            &json!({
                "sessionId": "root",
                "workspace": {"workspacePath": WORKSPACE},
                "revision": "stale",
                "operationId": "op",
            }),
        )
        .await
        .unwrap();
    assert_eq!(stale["status"], "blocked");
    assert_eq!(stale["reason"], "changed");

    let result = engine
        .session_data(
            Method::SessionDataDeletionExecute,
            &json!({
                "sessionId": "root",
                "workspace": {"workspacePath": WORKSPACE},
                "revision": preview["revision"],
                "operationId": "op",
            }),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "deleted");
    let calls = store.calls();
    let begin = calls
        .iter()
        .position(|call| call.starts_with("begin:"))
        .unwrap();
    let remove = calls.iter().position(|call| call == "remove:root").unwrap();
    let complete = calls
        .iter()
        .position(|call| call == "complete:root")
        .unwrap();
    assert!(begin < remove && remove < complete);
}

#[tokio::test]
async fn execute_returns_incomplete_when_files_fail_and_keeps_receipt() {
    let store = Arc::new(Store {
        files: files(),
        snapshot: json!({
            "workspacePath": WORKSPACE,
            "revision": "snapshot",
            "sessionIds": ["root", "child"],
            "forks": [],
            "references": [],
            "foreignRuntime": false,
            "localRuntimeIds": [],
            "pendingWork": false,
            "deleting": true,
            "completed": false,
        }),
        fail_files: BTreeSet::from(["child".into()]),
        ..Store::default()
    });
    let mut engine = engine(store.clone(), &[]).await;
    let result = engine
        .session_data(
            Method::SessionDataDeletionExecute,
            &json!({
                "sessionId": "root",
                "workspace": {"workspacePath": WORKSPACE},
                "revision": "ignored-after-admission",
                "operationId": "op",
            }),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "incomplete");
    assert_eq!(result["reason"], "unavailable");
    assert!(
        !store
            .calls()
            .iter()
            .any(|call| call.starts_with("complete:")),
        "文件失败不得删除正文"
    );
    assert!(
        !engine.sessions.contains_key("root"),
        "释放发生在删除凭据准入之后"
    );
}
