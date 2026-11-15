//! 会话运行实例的停止/重启/失败收口测试。
//! 拆分自 `session_lifecycle_tests.rs`，测试体逐字搬移，只为把源文件保持在 400 行上限内。
use super::*;

#[tokio::test]
async fn stop_releases_the_runtime_and_keeps_the_persisted_history() {
    let store = Arc::new(Store::persisted());
    let mut engine = engine(store.clone(), true).await;
    call(&mut engine, Method::SessionLifecycleStop, params(SESSION))
        .await
        .unwrap();
    assert!(engine.sessions.is_empty());
    // 只关闭 runtime：没有软删、没有提交持久行；空草稿按既有收口路径回收。
    assert!(!store.calls().contains(&"commit"));
    assert!(!store.calls().contains(&"load"));
    let snapshot = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        params(SESSION),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["state"], "unloaded");
    // 幂等：再停一次只有存在性预检，不重复释放。
    let before = store.calls().len();
    call(&mut engine, Method::SessionLifecycleStop, params(SESSION))
        .await
        .unwrap();
    let after: Vec<&str> = store.calls()[before..].to_vec();
    assert_eq!(after, ["exists"]);
}

#[tokio::test]
async fn restart_stops_then_activates_with_a_new_generation() {
    let store = Arc::new(Store::persisted());
    let mut engine = engine(store.clone(), true).await;
    call(
        &mut engine,
        Method::SessionLifecycleRestart,
        params(SESSION),
    )
    .await
    .unwrap();
    assert!(engine.sessions.contains_key(SESSION));
    let snapshot = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        params(SESSION),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["state"], "ready");
    assert_eq!(snapshot["generation"], 1);
    assert_eq!(snapshot["lastError"], Value::Null);
}

#[tokio::test]
async fn a_failed_activation_records_the_error_and_leaves_nothing_resident() {
    let store = Arc::new(Store {
        fail_load: true,
        ..Store::persisted()
    });
    let mut engine = engine(store.clone(), false).await;
    let error = call(
        &mut engine,
        Method::SessionLifecycleEnsureReady,
        params(SESSION),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("recovery failed"));
    assert!(engine.sessions.is_empty());
    let snapshot = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        params(SESSION),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["state"], "unloaded");
    assert_eq!(snapshot["lastError"]["operation"], "ensureReady");
    assert_eq!(snapshot["lastError"]["code"], "operationFailed");
}

#[tokio::test]
async fn a_failed_release_faults_the_session_and_blocks_implicit_recovery() {
    let store = Arc::new(Store::persisted());
    let mut engine = engine(store.clone(), true).await;
    store.fail_release.store(true, Ordering::SeqCst);
    call(&mut engine, Method::SessionLifecycleStop, params(SESSION))
        .await
        .unwrap_err();
    let snapshot = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        params(SESSION),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["state"], "faulted");
    assert_eq!(snapshot["lastError"]["operation"], "stop");
}

#[tokio::test]
async fn unsupported_fields_are_rejected_before_any_probe() {
    let store = Arc::new(Store::persisted());
    let mut engine = engine(store.clone(), false).await;
    let error = call(
        &mut engine,
        Method::SessionLifecycleGetState,
        json!({"sessionId": SESSION, "force": true}),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        RuntimeError::classify(&error),
        RuntimeError::InvalidParams(_)
    ));
    assert!(store.calls().is_empty());
}

/// 3.18 F7：本运行时没有工作区来源的 MCP 声明，信任审核必须 typed 拒绝，
/// 不能返回「已信任」或静默成功。
#[tokio::test]
async fn workspace_mcp_trust_is_answered_as_unavailable() {
    let store = Arc::new(Store::persisted());
    let engine = engine(store, false).await;
    let result = engine
        .workspace_mcp_trust(&json!({
            "workspace": {"workspacePath": WORKSPACE},
            "serverName": "docs",
            "declarationDigest": "sha256:abc",
            "trusted": true
        }))
        .unwrap();
    assert_eq!(
        result,
        json!({"accepted": false, "reasonCode": "workspace_mcp_trust_unavailable"})
    );
    let error = engine
        .workspace_mcp_trust(&json!({"workspace": {"workspacePath": WORKSPACE}}))
        .unwrap_err();
    assert!(matches!(
        RuntimeError::classify(&error),
        RuntimeError::InvalidParams(_)
    ));
}
