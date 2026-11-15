//! Parity with Node's workspace hook snapshot, trust evaluation, records,
//! review requests and store file (`fixtures/workspace-hooks.json`).
use super::trust::{self, Policy, Record, ReviewHost, TrustState};
use super::workspace::{self, RuntimeRoot, Snapshot};
use super::{HookEvent, Program, Shell};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../fixtures/workspace-hooks.json")).unwrap()
}

fn build(case: &Value) -> (RuntimeRoot, Snapshot) {
    let sources: Vec<_> = case["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let path = s["path"].as_str().unwrap();
            workspace::source(
                path,
                "/w",
                s["hooks"].clone(),
                s["order"].as_u64().unwrap() as usize,
            )
        })
        .collect();
    let default = json!({"enabled":false,"timeoutMs":60000,"maxOutputBytes":32768});
    let mut roots = vec![&default];
    roots.extend(case["roots"].as_array().unwrap());
    let root = workspace::runtime_root(&roots);
    let snapshot = workspace::snapshot(" id-1 ", "/w", &sources, root).unwrap();
    (root, snapshot)
}

fn snapshot_value(s: &Snapshot) -> Value {
    let hooks: Vec<Value> = s
        .hooks
        .iter()
        .map(|e| {
            let mut v = json!({"reviewItemId":e.review_item_id,"event":e.event.as_str(),"matcherIndex":e.matcher_index,
                "hookIndex":e.hook_index,"sourceFileIndex":e.source_file_index,"sourceRelativePath":e.source_relative_path,
                "matcher":e.matcher,"resolvedTimeoutMs":e.resolved_timeout_ms,"resolvedMaxOutputBytes":e.resolved_max_output_bytes,
                "sourceRootEnabled":e.source_root_enabled,"declarationEnabled":e.declaration_enabled,
                "runtimeHooksEnabled":e.runtime_hooks_enabled,"configuredEnabled":e.configured_enabled,"editable":e.editable,
                "declarationDigestAlgorithm":"sha256","hookDeclarationDigest":e.digest,"type":e.kind()});
            if let Some(status) = &e.status_message {
                v["statusMessage"] = status.clone().into();
            }
            // Node canonical entry 只在实际声明 `onError` 时带该键（allow / deny）。
            if let Some(on_error) = e.on_error {
                v["onError"] = on_error.as_str().into();
            }
            match &e.program {
                Program::Command { command, shell, background } => {
                    v["command"] = command.clone().into();
                    if *background {
                        v["async"] = true.into();
                    }
                    match shell {
                        Shell::Unset => {}
                        Shell::Default => v["shell"] = true.into(),
                        Shell::Path(p) => v["shell"] = p.clone().into(),
                    }
                }
                Program::Process { command, args } => {
                    v["command"] = command.clone().into();
                    if !args.is_empty() {
                        v["args"] = json!(args);
                    }
                }
            }
            v
        })
        .collect();
    let sources: Vec<Value> = s
        .source_files
        .iter()
        .map(|f| {
            let mut root = json!({});
            for key in ["enabled", "timeoutMs", "maxOutputBytes"] {
                if !f.hooks[key].is_null() {
                    root[key] = f.hooks[key].clone();
                }
            }
            json!({"canonicalPath":f.canonical_path,"baseDir":f.base_dir,"discoveryOrder":f.discovery_order,
                "configFileKind":f.kind,"explicitProjectConfig":f.explicit,"editable":f.editable,"hooksRoot":root})
        })
        .collect();
    json!({"schemaVersion":1,"workspaceIdentity":s.workspace_identity,"discoveredAt":"2026-01-01T00:00:00.000Z",
        "sourceFiles":sources,"hooks":hooks,"digestAlgorithm":"sha256","bundleDigest":s.bundle_digest})
}

#[test]
fn numbers_print_like_javascript() {
    for case in fixtures()["numbers"].as_array().unwrap() {
        assert_eq!(
            super::digest::js_number(case[0].as_f64().unwrap()),
            case[1].as_str().unwrap()
        );
    }
}

#[test]
fn snapshots_and_digests_match_node() {
    for case in fixtures()["snapshots"].as_array().unwrap() {
        let (root, snapshot) = build(case);
        let expected = &case["runtimeRoot"];
        assert_eq!(
            (root.enabled, root.timeout_ms, root.max_output_bytes),
            (
                expected["enabled"] == true,
                expected["timeoutMs"].as_u64().unwrap(),
                expected["maxOutputBytes"].as_u64().unwrap()
            )
        );
        assert_eq!(
            snapshot_value(&snapshot),
            case["snapshot"],
            "{}",
            case["name"]
        );
    }
}

fn record(snapshot: &Snapshot, index: usize, digest: Option<&str>) -> Record {
    let entry = &snapshot.hooks[index];
    Record {
        workspace_identity: snapshot.workspace_identity.clone(),
        hook_declaration_digest: digest
            .map(str::to_owned)
            .unwrap_or_else(|| entry.digest.clone()),
        digest_algorithm: "sha256".into(),
        decision: "trusted".into(),
        granted_at: "2026-01-01T00:00:00.000Z".into(),
        last_used_at: None,
        bundle_digest_at_grant: None,
        event_at_grant: entry.event.as_str().into(),
        display_command_at_grant: entry.display_command(),
        source_path_at_grant: entry.source_relative_path.clone(),
        source_discovery_order_at_grant: Some(
            snapshot.source_files[entry.source_file_index].discovery_order as u64,
        ),
        matcher_at_grant: Some(entry.matcher.clone()),
        matcher_index_at_grant: Some(entry.matcher_index as u64),
        hook_index_at_grant: Some(entry.hook_index as u64),
        app_version_at_grant: None,
    }
}

#[test]
fn evaluation_matches_node() {
    let f = fixtures();
    let (_, snapshot) = build(&f["snapshots"][0]);
    let stale = "f".repeat(64);
    for case in f["evaluations"].as_array().unwrap() {
        let records = match case["name"].as_str().unwrap() {
            "trusted" => vec![record(&snapshot, 0, None), record(&snapshot, 1, None)],
            "stale" => vec![record(&snapshot, 0, Some(&stale))],
            "corrupt" | "deny" | "trusted-only" => vec![record(&snapshot, 0, None)],
            _ => vec![],
        };
        let revoked: BTreeSet<_> = case["revoked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| {
                (
                    snapshot.workspace_identity.clone(),
                    d.as_str().unwrap().to_owned(),
                )
            })
            .collect();
        let policy = match case["policy"].as_str().unwrap() {
            "deny" => Policy::Deny,
            "allow_trusted_only" => Policy::AllowTrustedOnly,
            _ => Policy::UserDecides,
        };
        let items = trust::evaluate(
            &snapshot,
            policy,
            &records,
            &revoked,
            case["corrupt"] == true,
        );
        let got: Vec<Value> = items
            .iter()
            .map(|i| {
                json!([
                    i.review_item_id,
                    i.trust_state.as_str(),
                    i.effective_runnable
                ])
            })
            .collect();
        assert_eq!(json!(got), case["items"], "{}", case["name"]);
    }
    let pending = trust::evaluate(&snapshot, Policy::UserDecides, &[], &BTreeSet::new(), false);
    // 第二条声明在配置中停用：不计入横幅的 pendingCount。
    assert_eq!(trust::pending_count(&pending), 1);
}

#[test]
fn grants_and_store_file_match_node() {
    let f = fixtures();
    let (_, snapshot) = build(&f["snapshots"][0]);
    let ids = [1, 0, 1].map(|i| snapshot.hooks[i].review_item_id.clone());
    let records =
        trust::grant_records(&snapshot, &ids, "2026-01-01T00:00:00.000Z", Some("9.9.9")).unwrap();
    assert_eq!(serde_json::to_value(&records).unwrap(), f["records"]);
    assert_eq!(
        trust::store_content(&records),
        f["storeContent"].as_str().unwrap()
    );
    assert!(trust::grant_records(&snapshot, &["nope".into()], "t", None).is_err());
    for case in f["stores"].as_array().unwrap() {
        let parsed = trust::parse_store(case["content"].as_str().unwrap());
        let got = parsed
            .map(|r| serde_json::to_value(r).unwrap())
            .unwrap_or(Value::Null);
        assert_eq!(got, case["records"], "{}", case["content"]);
    }
}

#[test]
fn review_request_matches_node() {
    let f = fixtures();
    let (_, snapshot) = build(&f["snapshots"][1]);
    let mut items = trust::evaluate(&snapshot, Policy::UserDecides, &[], &BTreeSet::new(), false);
    items[0].trust_state = TrustState::TrustedPersistent;
    let host = ReviewHost {
        session_id: "s-1",
        run_id: "workspace-hook-run:s-1:r",
        workspace_label: "w",
        remote_session_id: Some("remote-1"),
    };
    let flow = (
        "workspace-hook-review:flow",
        2,
        "workspace-hook-interaction:i",
    );
    assert_eq!(
        trust::review_request(&snapshot, &items, flow, &host, 1000),
        f["reviewRequest"]
    );
}

#[test]
fn project_hooks_go_after_user_hooks() {
    let f = fixtures();
    let (_, snapshot) = build(&f["snapshots"][0]);
    let project = workspace::registrations(&snapshot);
    assert_eq!(project[0].source, "project.workspace-hook-0-PreToolUse-0-0");
    let user = super::registrations(
        &json!({"enabled":true,"events":{"PreToolUse":[{"hooks":[{"type":"command","command":"u"}]}]}}),
        Some("/u.json"),
    );
    let mut plugin = user[0].clone();
    plugin.source_kind = super::SourceKind::Plugin;
    let merged = workspace::insert(&[user[0].clone(), plugin], project);
    let order: Vec<_> = merged
        .iter()
        .filter(|r| r.event == HookEvent::PreToolUse)
        .map(|r| r.source_kind)
        .collect();
    use super::SourceKind::*;
    assert_eq!(order, [User, Project, Plugin]);
    assert_eq!(merged.last().unwrap().event, HookEvent::Stop);
}

#[test]
fn declared_on_error_changes_the_declaration_digest_but_not_project_execution() {
    // `onError` 是每 Hook 的失败策略（不是事件）。它必须进声明摘要：加/改都要重新审核；
    // 但 TS `workspaceEntryToHookConfig` 不把它转给注册，所以项目 hook 执行仍按缺省 allow。
    let default = json!({"enabled":false,"timeoutMs":60000,"maxOutputBytes":32768});
    let source_of = |hook: Value| {
        workspace::source(
            "/w/.zcodium/config.json",
            "/w",
            json!({"enabled":true,"events":{"PreToolUse":[{"hooks":[hook]}]}}),
            0,
        )
    };
    let root = workspace::runtime_root(&[&default]);
    let plain = workspace::snapshot(
        "id",
        "/w",
        &[source_of(json!({"type":"command","command":"echo hi"}))],
        root,
    )
    .unwrap();
    let deny = workspace::snapshot(
        "id",
        "/w",
        &[source_of(
            json!({"type":"command","command":"echo hi","onError":"deny"}),
        )],
        root,
    )
    .unwrap();
    assert_eq!(deny.hooks[0].on_error, Some(super::OnErrorPolicy::Deny));
    assert_eq!(plain.hooks[0].on_error, None);
    assert_ne!(plain.hooks[0].digest, deny.hooks[0].digest);
    assert_ne!(plain.bundle_digest, deny.bundle_digest);
    // 摘要变化让旧信任变 stale（trust 层按 digest 判定，无需新事件）。
    let granted = super::trust::parse_record(&json!({
        "workspaceIdentity": "id",
        "hookDeclarationDigest": plain.hooks[0].digest,
        "digestAlgorithm": "sha256",
        "decision": "trusted",
        "grantedAt": "2026-01-01T00:00:00.000Z",
        "eventAtGrant": "PreToolUse",
        "displayCommandAtGrant": "echo hi",
        "sourcePathAtGrant": ".zcodium/config.json",
        "sourceDiscoveryOrderAtGrant": 0,
        "matcherAtGrant": null,
        "matcherIndexAtGrant": 0,
        "hookIndexAtGrant": 0,
    }))
    .unwrap();
    let items = super::trust::evaluate(
        &deny,
        super::trust::Policy::UserDecides,
        &[granted],
        &BTreeSet::new(),
        false,
    );
    assert_eq!(items[0].trust_state, super::trust::TrustState::StaleDigest);
    // 注册表仍只给 allow：没有第二条执行路径，也没有伪 OnError 事件。
    for registration in workspace::registrations(&deny) {
        assert_eq!(registration.on_error, super::OnErrorPolicy::Allow);
    }
    assert!(super::HookEvent::parse("OnError").is_none());
}
