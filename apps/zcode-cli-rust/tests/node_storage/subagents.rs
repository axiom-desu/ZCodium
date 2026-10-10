// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::*;

#[tokio::test]
async fn a_subagent_child_is_stored_as_a_node_child_session() {
    let mut h = harness::start(Some("subagent"), None).await;
    let session = h.create("c1", "spawn a child").await;
    let conn = h.settled(&session, 1).await;
    let child: String = conn
        .query_row(
            "select id from session where parent_id = ?",
            [&session],
            |r| r.get(0),
        )
        .unwrap();
    assert!(child.starts_with("sess_subagent_agent_"), "{child}");
    let row = sessions::get(&conn, &child).unwrap().unwrap();
    assert_eq!(row.task_type, "subagent_child");
    assert_eq!(row.title, "Inspect a.ts");
    assert_eq!(row.title_source, "first_input");
    let messages = zcode_cli_state::node::messages::messages(&conn, &child).unwrap();
    // 子会话首轮前落模型切换分隔线，任务提示以 coordinator_input 呈现。
    assert_eq!(messages[0].parts[0]["timelineType"], "model_change");
    assert!(messages[0].parts[0].get("fromModel").is_none());
    let prompt = &messages[1].info;
    assert_eq!(prompt["metadata"]["inputPresentation"], "coordinator_input");
    assert_eq!(prompt["agent"], "zcode-general-purpose");
    let resumed = resume::resume(&conn, &child, &|_| None, None)
        .unwrap()
        .unwrap();
    let history = &resumed.history.messages;
    assert_eq!(history[0]["content"], "Inspect a.ts");
    assert_eq!(history.last().unwrap()["content"], "Done.");
    // 父会话的 Agent 工具结果带 agentId，冷投影据此还原子代理行。
    let parent = resume::resume(&conn, &session, &|_| None, None)
        .unwrap()
        .unwrap();
    assert!(
        parent
            .conversation
            .rows
            .iter()
            .any(|r| r["kind"] == "subagent"
                || r["subagent"].is_object()
                || r["toolName"] == "Agent"),
        "{:#?}",
        parent.conversation.rows
    );
    harness::dump(&h, &conn, &session);
    harness::dump_as(&h, &conn, &child, "rust-child.json");
}

#[tokio::test]
async fn a_background_subagent_result_opens_a_node_notification_turn() {
    let mut h = harness::start(Some("notify"), None).await;
    let session = h.create("c1", "spawn a background child").await;
    // 父会话首轮与后台结果轮各有一个稳定边界。
    let conn = h.settled(&session, 2).await;
    let ledger: (String, String, String) = conn
        .query_row(
            "select id, status, payload from session_input where session_id = ? and kind = 'backgroundNotification'",
            [&session],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert!(ledger.0.starts_with("runtime_command_"), "{ledger:?}");
    assert_eq!(ledger.1, "promoted");
    let payload: Value = serde_json::from_str(&ledger.2).unwrap();
    assert_eq!(payload["originMeta"]["backgroundSource"], "subagent");
    assert_eq!(payload["originMeta"]["title"], "Look around");
    let notice = zcode_cli_state::node::messages::messages(&conn, &session)
        .unwrap()
        .into_iter()
        .find(|m| m.info["source"] == "background_task")
        .expect("notification notice");
    assert_eq!(
        notice.info["metadata"]["inputPresentation"],
        "task_notification"
    );
    assert_eq!(notice.info["anchor"]["origin"], "backgroundResult");
    // 模型上下文里的后台结果按 Node 呈现（系统通知前缀 + incoming_message 包装）。
    let resumed = resume::resume(&conn, &session, &|_| None, None)
        .unwrap()
        .unwrap();
    let presented = resumed
        .history
        .messages
        .iter()
        .find(|m| m["_zcode_source"] == "legacy_synthetic")
        .expect("presented notification");
    let content = presented["content"].as_str().unwrap();
    assert!(
        content.starts_with("<system-reminder>\n[SYSTEM NOTIFICATION"),
        "{content}"
    );
    harness::dump(&h, &conn, &session);
}
