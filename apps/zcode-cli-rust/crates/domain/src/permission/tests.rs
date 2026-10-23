//! Parity with the TS permission implementation. Fixtures come from
//! `scripts/zcode-cli-rust-permission-fixtures.mjs`, which runs the Node functions.
use super::*;
use serde_json::{Value, json};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../fixtures/permission.json")).unwrap()
}

fn behavior_name(behavior: Behavior) -> &'static str {
    match behavior {
        Behavior::Allow => "allow",
        Behavior::Ask => "ask",
        Behavior::Deny => "deny",
    }
}

#[test]
fn decision_matrix_matches_node() {
    let fixtures = fixtures();
    for case in fixtures["decisions"].as_array().unwrap() {
        let context = &case["context"];
        let tool = context["toolName"].as_str().unwrap();
        let capability: ToolCapability =
            serde_json::from_value(case["capability"].clone()).unwrap();
        let config = &case["config"];
        let mut policy = Policy {
            config: Config::from_config(config),
            session_rules: Ruleset::default(),
        };
        let updates: Vec<Update> = serde_json::from_value(case["sessionRules"].clone()).unwrap();
        policy.session_rules = apply_updates(&policy.session_rules, &updates);
        let project: Option<Ruleset> =
            serde_json::from_value(case["projectRules"].clone()).unwrap();
        let mode = crate::execution::Mode::parse(context["mode"].as_str().unwrap()).unwrap();
        let ctx = Context {
            tool,
            input: &context["input"],
            mode,
            plan_enabled: context["planEnabled"] == true,
            working_directory: context["workingDirectory"].as_str(),
        };
        let decision = policy.check(&ctx, &resolve(tool, &capability), project.as_ref(), None);
        let mut actual = json!({
            "decision": behavior_name(decision.behavior),
            "ruleId": decision.rule_id,
            "reason": decision.reason,
            "riskLevel": decision.risk_level,
            "sideEffectScope": decision.side_effect_scope,
        });
        if decision.always_ask {
            actual["alwaysAsk"] = true.into();
        }
        assert_eq!(actual, case["expected"], "{tool} {context}");
    }
}

#[test]
fn static_capabilities_cover_rust_tools() {
    for tool in [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        "TaskOutput",
        "TaskStop",
        "Skill",
        "AskUserQuestion",
        "TodoRead",
        "TodoWrite",
        "Agent",
        "SendMessage",
        "EnterPlanMode",
        "ExitPlanMode",
    ] {
        assert!(tool_capability(tool).is_some(), "{tool}");
    }
}

#[test]
fn options_updates_and_texts_match_node() {
    let fixtures = fixtures();
    for case in fixtures["options"].as_array().unwrap() {
        let source = &case["source"];
        let suggested: Vec<Update> = source
            .get("suggestedPermissionUpdates")
            .map(|v| serde_json::from_value(v.clone()).unwrap())
            .unwrap_or_default();
        let options = protocol_options(
            source["toolName"].as_str().unwrap(),
            &source["input"],
            &suggested,
            source["optionsPolicy"].as_str(),
        );
        assert_eq!(Value::Array(options), case["expected"], "{source}");
    }
    for case in fixtures["defaultUpdates"].as_array().unwrap() {
        let updates = default_updates(case["toolName"].as_str().unwrap(), &case["input"], None);
        assert_eq!(serde_json::to_value(updates).unwrap(), case["expected"]);
    }
    assert_eq!(
        denied_content(Some("  use pnpm  ")),
        fixtures["texts"]["deniedWithFeedback"]
    );
    assert_eq!(denied_content(Some("  ")), denied_by_user());
    for case in fixtures["webfetchCases"].as_array().unwrap() {
        let url = case["url"].as_str().unwrap();
        assert_eq!(
            options::webfetch_preapproved(url),
            case["expected"] == true,
            "{url}"
        );
    }
}

#[test]
fn v4_options_map_ids_and_kinds_like_the_projection() {
    let options = v4_options(
        "CreateWorkflow",
        &json!({}),
        &[],
        Some("session-always-allow"),
    );
    let ids: Vec<&str> = options
        .iter()
        .map(|o| o["optionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["allowOnce", "allowSession", "deny", "workflowRefine"]);
    assert_eq!(options[1]["kind"], "allowAlways");
    let options = v4_options("Write", &json!({"file_path":"/a"}), &[], None);
    assert_eq!(options[1]["optionId"], "allowAlways");
    assert_eq!(
        options[1]["response"]["permissionUpdates"][0]["rules"][0]["ruleContent"],
        "/a"
    );
}

#[test]
fn rule_updates_dedupe_and_keep_unknown_keys() {
    let base: Ruleset =
        serde_json::from_value(json!({"mode":"x","allow":[{"toolName":"Read"}]})).unwrap();
    let updates: Vec<Update> = serde_json::from_value(json!([
        {"type":"addRules","behavior":"allow","rules":[{"toolName":"Read"},{"toolName":"Write","ruleContent":"a"}]},
        {"type":"removeRules","behavior":"deny","rules":[{"toolName":"Bash"}]}
    ]))
    .unwrap();
    let next = apply_updates(&base, &updates);
    assert_eq!(
        serde_json::to_value(&next).unwrap(),
        json!({"mode":"x","version":1,"allow":[{"toolName":"Read"},{"toolName":"Write","ruleContent":"a"}]})
    );
}

#[test]
fn rule_content_matching_follows_node() {
    assert!(rules::matches_content("npm test", "npm test:*"));
    assert!(rules::matches_content("npm test --watch", "npm test:*"));
    assert!(!rules::matches_content("npm tests", "npm test:*"));
    assert!(rules::matches_content("/a/b/c", "/a/*"));
    assert!(!rules::matches_content("/a/b\nc", "/a/*"));
    assert!(rules::matches_content("a.b", "a.*"));
    assert!(!rules::matches_content("xa.b", "a.*"));
    assert!(rules::matches_content("abc", "a*c"));
    assert!(rules::matches_content("ac", "a*c"));
    assert!(!rules::matches_content("ab", "a*c"));
}

/// ToolSearch 是 native/local 两种曝光共用的只读控制入口：build/plan 都必须放行。
/// 该事实只来自生成的 `schema/tool-permissions.json`（TS `builtInTools` 投影），
/// 不在 Rust 侧另写第二份名单。
#[test]
fn tool_search_capability_is_read_only_in_plan_and_build() {
    let cap = tool_capability("ToolSearch").expect("ToolSearch capability");
    assert_eq!(cap.read_only, Some(true));
    assert_eq!(cap.destructive, Some(false));
    assert_eq!(cap.needs_approval, Some(false));
    assert_eq!(cap.side_effect_scope.as_deref(), Some("none"));
    assert_eq!(cap.risk_level.as_deref(), Some("low"));
    assert_eq!(
        cap.permission
            .as_ref()
            .and_then(|p| p.permission.as_deref()),
        Some("tool.search")
    );

    let resolved = resolve("ToolSearch", cap);
    let input = json!({"query": "read file", "max_results": 5});
    let policy = Policy::default();
    for (mode, plan_enabled) in [
        (crate::execution::Mode::Build, false),
        (crate::execution::Mode::Build, true),
        (crate::execution::Mode::Edit, false),
        (crate::execution::Mode::Yolo, true),
    ] {
        let ctx = Context {
            tool: "ToolSearch",
            input: &input,
            mode,
            plan_enabled,
            working_directory: Some("/w"),
        };
        let decision = policy.check(&ctx, &resolved, None, None);
        assert_eq!(
            decision.behavior,
            Behavior::Allow,
            "{mode:?} plan={plan_enabled}: {}",
            decision.reason
        );
        assert!(
            decision.rule_id.starts_with("mode.plan.readOnly")
                || decision.rule_id.starts_with("mode.build.readOnly")
                || decision.rule_id == "mode.yolo",
            "unexpected rule {}",
            decision.rule_id
        );
    }
}

/// 包装入口本身不是只读工具：模型不能绕过 permission/hook 直接调用它。
#[test]
fn deferred_tool_call_wrapper_is_not_read_only() {
    let cap = tool_capability("DeferredToolCall").expect("DeferredToolCall capability");
    assert_eq!(cap.read_only, Some(false));
    assert_eq!(cap.destructive, Some(false));
    let resolved = resolve("DeferredToolCall", cap);
    let input = json!({"name": "Write", "input": {"file_path": "/w/a", "content": "x"}});
    let ctx = Context {
        tool: "DeferredToolCall",
        input: &input,
        mode: crate::execution::Mode::Build,
        plan_enabled: true,
        working_directory: Some("/w"),
    };
    let decision = Policy::default().check(&ctx, &resolved, None, None);
    assert_eq!(decision.behavior, Behavior::Deny);
    assert_eq!(decision.rule_id, "mode.plan.nonReadOnly");
}
