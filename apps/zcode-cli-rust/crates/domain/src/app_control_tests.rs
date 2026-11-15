//! App 会话控制契约测试：封闭意图表、身份注入、根会话判定、回执形状穷举。
use super::*;
use serde_json::json;

fn by_tool(tool: &str) -> &'static Intent {
    intent(tool).unwrap_or_else(|| panic!("{tool} must be an intent"))
}

#[test]
fn intent_table_is_closed_and_matches_the_wire_method_prefix() {
    assert_eq!(INTENTS.len(), 12);
    let tools: Vec<&str> = INTENTS.iter().map(|intent| intent.tool).collect();
    assert_eq!(tools, TOOL_NAMES);
    for intent in &INTENTS {
        assert_eq!(method(intent), format!("appControl/{}", intent.action));
        assert!(is_tool(intent.tool));
    }
    // CLI 八工具与未知名字都不属于 App 面。
    for name in [
        "ListSessionsCli",
        "Sessions",
        "Read",
        "appControl/listProjects",
    ] {
        assert!(!is_tool(name), "{name}");
    }
}

#[test]
fn only_write_intents_carry_a_request_identity() {
    for name in [
        "CreateSession",
        "ForkSession",
        "SendToSession",
        "InterruptSession",
        "RenameSession",
        "SetSessionArchived",
        "SetSessionPinned",
    ] {
        assert!(by_tool(name).request_id, "{name}");
    }
    for name in [
        "ListProjects",
        "ListSessions",
        "ReadSession",
        "WaitSessions",
        "OpenSession",
    ] {
        assert!(!by_tool(name).request_id, "{name}");
    }
}

#[test]
fn request_id_comes_from_the_call_or_the_replayed_retry_only() {
    let intent = by_tool("SendToSession");
    let prepared = prepare_input(
        intent,
        &json!({"sessionId":"s2","prompt":"hi","retryOf":"req-7"}),
        "call-1",
    )
    .unwrap();
    assert_eq!(
        prepared,
        json!({"sessionId":"s2","prompt":"hi","requestId":"req-7"})
    );

    let fresh = prepare_input(intent, &json!({"sessionId":"s2","prompt":"hi"}), "call-9").unwrap();
    assert_eq!(fresh["requestId"], "call-9");
    // retryOf 只用于回放身份，绝不进入 Host input 的其它字段。
    assert!(fresh.get("retryOf").is_none());

    for forged in [
        json!({"retryOf":""}),
        json!({"retryOf":"  "}),
        json!({"retryOf":7}),
    ] {
        let mut input = json!({"sessionId":"s2","prompt":"hi"});
        input["retryOf"] = forged["retryOf"].clone();
        assert!(prepare_input(intent, &input, "call-1").is_err(), "{input}");
    }
    // 非对象输入直接是参数错误，不产生 requestId。
    for invalid in [json!(null), json!([]), json!("x")] {
        assert_eq!(
            prepare_input(intent, &invalid, "call-1"),
            Err(ERROR_INPUT_OBJECT.into())
        );
    }
}

#[test]
fn read_intents_reject_a_retry_identity_instead_of_dropping_it() {
    for name in ["ListProjects", "ReadSession", "WaitSessions", "OpenSession"] {
        let error =
            prepare_input(by_tool(name), &json!({"retryOf":"req-1"}), "call-1").unwrap_err();
        assert_eq!(error, ERROR_RETRY_UNSUPPORTED, "{name}");
    }
    let plain =
        prepare_input(by_tool("ListSessions"), &json!({"archived":"exclude"}), "c").unwrap();
    assert_eq!(plain, json!({"archived":"exclude"}));
    assert!(plain.get("requestId").is_none());
}

#[test]
fn replies_only_accept_the_closed_envelope() {
    let intent = by_tool("ListProjects");
    assert_eq!(
        parse_reply(intent, &json!({"ok":true,"result":{"projects":[]}})),
        Ok(json!({"projects":[]}))
    );
    // Host 自己给出的 unknown 是结论，原样保留（不改写成成功或失败）。
    assert_eq!(
        parse_reply(intent, &json!({"ok":true,"result":{"status":"unknown"}})),
        Ok(json!({"status":"unknown"}))
    );
    let failure = parse_reply(
        intent,
        &json!({"ok":false,"error":{"code":"forbidden","message":"not a bound root"}}),
    )
    .unwrap_err();
    assert!(failure.contains("forbidden"), "{failure}");
    assert!(failure.contains("not a bound root"), "{failure}");
    // 空回执（旧 Host -32601 / 参数拒绝 -32602 都投影成 null）与其它形状都不是成功。
    for reply in [
        Value::Null,
        json!({}),
        json!({"ok":true}),
        json!({"result":{}}),
        json!({"ok":false}),
        json!({"ok":"true","result":{}}),
        json!([]),
    ] {
        assert_eq!(
            parse_reply(intent, &reply),
            Err(ERROR_REJECTED.into()),
            "{reply}"
        );
    }
    // 缺失回执只说明 Host 拒绝/不可用：结论未知，文案不得声称意图未生效。
    assert!(ERROR_REJECTED.contains("unknown"));
    for claim in ["not applied", "was not applied", "did not apply"] {
        assert!(!ERROR_REJECTED.contains(claim), "{claim}");
    }
}

#[test]
fn the_grant_needs_the_host_capability_and_a_root_session() {
    // 授权 + mainRoot + 非子代理才是 App 会话控制者。
    assert!(granted(true, "interactive", false, false));
    assert!(granted(true, "fork", false, false));
    assert!(granted(true, "workflow_parent", false, false));
    // TS `resolveAppControlEnabledBinding`：fork 是独立任务，带父会话仍是 mainRoot。
    assert!(granted(true, "fork", true, false));
    assert!(is_main_root("fork", true));
    // 未授权（旧 Host / 未装配 Host / TUI / 无头）：即使根会话也不可用。
    assert!(!granted(false, "interactive", false, false));
    // 子会话与子代理运行都不行。
    assert!(!granted(true, "interactive", true, false));
    assert!(!granted(true, "workflow_parent", true, false));
    assert!(!granted(true, "interactive", false, true));
    for task_type in ["subagent_child", "workflow_child", "selection_side_chat"] {
        assert!(!granted(true, task_type, false, false), "{task_type}");
    }
    // 静态方法名不另立事实：与 action 拼出的名字逐条一致。
    for intent in &INTENTS {
        assert_eq!(intent.method, method(intent), "{}", intent.tool);
    }
    for task_type in ["interactive", "fork", "workflow_parent"] {
        assert!(is_root_task_type(task_type), "{task_type}");
    }
}
