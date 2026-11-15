//! `CronPauseSelf` 契约测试：身份优先、空 schema 严格、Host 结论穷举。
use super::*;

#[test]
fn empty_input_is_strict_and_rejects_a_forged_target() {
    assert_eq!(validate_input(&json!({})), Ok(()));
    // 模型塞不进目标 id：伪造 id 是参数错误，不会被当作暂停对象。
    for forged in [
        json!({"automationId":"automation-evil"}),
        json!({"id":"automation-evil"}),
        json!({"automation_id":"automation-evil"}),
        json!(null),
        json!([]),
    ] {
        assert!(validate_input(&forged).is_err(), "{forged}");
    }
    let error = validate_input(&json!({"automationId":"automation-evil"})).unwrap_err();
    assert!(error.contains("automationId"), "{error}");
}

#[test]
fn provider_schema_takes_no_input() {
    let parameters = pause_self_parameters();
    assert_eq!(parameters["type"], "object");
    assert_eq!(parameters["properties"], json!({}));
    assert_eq!(parameters["additionalProperties"], json!(false));
    assert_eq!(
        pause_self_output_parameters()["required"],
        json!(["paused", "id", "message"])
    );
    let definition = pause_self_definition();
    assert_eq!(definition["function"]["name"], PAUSE_SELF);
}

#[test]
fn only_the_trusted_submission_id_counts() {
    assert_eq!(admitted_id(Some("automation-42")), Some("automation-42"));
    assert_eq!(
        admitted_id(Some("  automation-42  ")),
        Some("automation-42")
    );
    // 空/空白不是身份：普通用户轮与任务元数据兜底信号都必须落空。
    assert_eq!(admitted_id(None), None);
    assert_eq!(admitted_id(Some("")), None);
    assert_eq!(admitted_id(Some("   ")), None);
}

#[test]
fn host_reply_must_be_the_strict_pause_shape() {
    assert_eq!(parse_pause(&json!({"paused":true})), Ok(true));
    assert_eq!(parse_pause(&json!({"paused":false})), Ok(false));
    // 协议层把 Host 的 -32601/-32602 回执投影成空结果：不能当成 paused=false。
    for rejected in [
        Value::Null,
        json!({}),
        json!({"paused":"true"}),
        json!({"paused":true,"extra":1}),
        json!({"deleted":true}),
        json!(true),
    ] {
        assert_eq!(
            parse_pause(&rejected),
            Err(ERROR_REJECTED.into()),
            "{rejected}"
        );
    }
}

#[test]
fn result_texts_match_the_node_branch() {
    let (paused, data) = pause_result("automation-42", true);
    assert_eq!(
        paused,
        "Paused automation automation-42. It will not run on schedule until the user resumes it."
    );
    assert_eq!(
        data,
        json!({"paused":true,"id":"automation-42","message":paused})
    );
    let (inactive, data) = pause_result("automation-42", false);
    assert_eq!(
        inactive,
        "Automation automation-42 is not active (already paused, completed, failed, or deleted), so nothing changed."
    );
    assert_eq!(data["paused"], json!(false));
}

#[test]
fn capability_declares_the_automation_permission() {
    // 能力声明只来自生成资产（TS `builtInTools` 投影），不在工具实现里另写一份。
    let capability = crate::permission::tool_capability(PAUSE_SELF).expect("declared");
    let resolved = crate::permission::resolve(PAUSE_SELF, capability);
    assert_eq!(
        resolved.permission_name.as_deref(),
        Some(PAUSE_SELF_PERMISSION)
    );
    assert_eq!(resolved.risk_level, "medium");
    assert_eq!(resolved.side_effect_scope, "workspace");
    assert!(!resolved.needs_approval);
    assert!(!resolved.read_only);
    assert!(!resolved.destructive);
    // 注册元数据与 Node entry 一致：defer + searchHint。
    let metadata = crate::tool_search::builtin_metadata(PAUSE_SELF);
    assert!(metadata.should_defer && !metadata.always_load);
    assert_eq!(
        metadata.search_hint.as_deref(),
        Some("pause the automation that triggered this run")
    );
}
