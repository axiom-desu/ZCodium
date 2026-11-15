// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! `measure/purge` 的响应形状、保留语义与失败编码。
use super::test_support::{Store, WORKSPACE, engine};
use crate::contract::Method;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[tokio::test]
async fn measure_sums_owned_trees_and_returns_memory() {
    let store = Arc::new(Store {
        trees: BTreeMap::from([("root".into(), vec!["root".into(), "child".into()])]),
        sizes: BTreeMap::from([("root".into(), 10), ("child".into(), 5)]),
        ..Store::default()
    });
    let mut engine = engine(store.clone(), &[]).await;
    let result = engine
        .session_data(
            Method::SessionDataMeasure,
            &json!({
                "sessionIds": ["root", "gone"],
                "directories": [{"workspacePath": WORKSPACE}],
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({
            "sessions": [
                {"sessionId": "root", "bytes": 15},
                {"sessionId": "gone", "bytes": 0},
            ],
            "memory": [{"workspacePath": WORKSPACE, "bytes": 4}],
        })
    );
    assert!(!store.calls().contains(&"remove:root".to_owned()));
}

#[tokio::test]
async fn purge_keeps_running_and_referenced_trees_and_reports_failures() {
    let store = Arc::new(Store {
        trees: BTreeMap::from([
            ("busy".into(), vec!["busy".into()]),
            ("root".into(), vec!["root".into(), "child".into()]),
            ("kept".into(), vec!["kept".into()]),
            ("bad".into(), vec!["bad".into()]),
        ]),
        referrers: BTreeMap::from([("kept".into(), vec!["outside".into()])]),
        sizes: BTreeMap::from([("root".into(), 10), ("child".into(), 5), ("bad".into(), 1)]),
        fail_files: BTreeSet::from(["bad".into()]),
        ..Store::default()
    });
    let mut engine = engine(store.clone(), &["busy"]).await;
    let result = engine
        .session_data(
            Method::SessionDataPurge,
            &json!({"sessionIds": ["busy", "root", "kept", "bad"], "directories": []}),
        )
        .await
        .unwrap();
    assert_eq!(
        result["kept"],
        json!([
            {"sessionId": "busy", "reason": "running"},
            {"sessionId": "kept", "reason": "referenced"},
        ])
    );
    assert_eq!(
        result["deleted"],
        json!([{"sessionId": "root", "bytes": 15}])
    );
    assert_eq!(
        result["failed"],
        json!([{"sessionId": "bad", "code": "unavailable"}])
    );
    let calls = store.calls();
    assert!(calls.contains(&"remove:root".to_owned()));
    assert!(calls.contains(&"purge:root".to_owned()));
    assert!(!calls.contains(&"remove:kept".to_owned()));
    assert!(!calls.contains(&"remove:busy".to_owned()));
    assert!(!calls.contains(&"purge:bad".to_owned()));
    // 释放只作用于本进程已加载的空闲会话，且必须早于文件删除。
    assert!(calls.contains(&"unregister:root".to_owned()) || !engine.sessions.contains_key("root"));
}

#[tokio::test]
async fn invalid_shapes_are_rejected_instead_of_silently_measured() {
    let store = Arc::new(Store::default());
    let mut engine = engine(store, &[]).await;
    for params in [
        json!({"sessionIds": ["root"]}),
        json!({"sessionIds": ["root"], "directories": [], "unknown": 1}),
        json!({"sessionIds": [""], "directories": []}),
    ] {
        assert!(
            engine
                .session_data(Method::SessionDataMeasure, &params)
                .await
                .is_err(),
            "非法参数必须失败：{params}"
        );
    }
}
