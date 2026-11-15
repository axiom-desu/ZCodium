//! 服务端原生工具轮次与 session features 的落库/冷读测试。
//! 拆分自 `tests.rs`，测试体逐字搬移，只为把源文件保持在 400 行上限内。
use super::super::{Outcome, Prompt};
use super::{ids, records, session};
use crate::node_history::hydrate;
use serde_json::{Value, json};

/// 3.18 R2：provider 原生工具轮次落库后冷恢复必须得到与热历史同一条 canonical 消息，
/// 服务端调用/结果按轮拆开（不能把多轮正文拼进一条 assistant）。
#[test]
fn provider_native_tool_rounds_survive_cold_restore() {
    let mut s = session();
    let mut next = ids();
    s.node_ensure_created(10, "search", "0.0.0");
    s.node_user_prompt(
        10,
        Prompt {
            message: "msg_user".into(),
            part: "part_user".into(),
            turn: "t1",
            text: "search",
            command: None,
            queue_id: None,
            metadata: None,
            tools: &[],
            files: vec![],
        },
    );
    s.node_step_started(20, ("msg_a1".into(), "part_s1".into()), "p", "m");
    s.node_model_status(
        &json!({"type": "model_request_completed", "finishReason": "stop",
        "usage": {"inputTokens": 10, "outputTokens": 2}}),
    );
    let call = json!({"type":"mcp_tool_use","id":"m1","name":"analyze_image",
        "input":{"image":"a"},"server_name":"zcode-provider-builtin"});
    let result = json!({"type":"mcp_tool_result","tool_use_id":"m1","is_error":false,
        "content":[{"type":"text","text":"a cat"}]});
    let thinking = json!({"type":"thinking","thinking":"look","signature":"sig"});
    let live = json!({"role": "assistant", "content": "answer",
    "_zcode_origin": {"provider": "p", "model": "m"},
    "reasoning_content": "look",
    "_zcode_anthropic_thinking": [thinking],
    "_zcode_anthropic_server_tools": [call, result],
    "_zcode_anthropic_server_rounds": [
        {"thinking": [thinking], "text": "", "call": call, "result": result},
        {"thinking": [], "text": "answer", "call": null, "result": null}
    ]});
    s.node_model_done(30, Some(&live), &mut next);
    s.node_finished(31, Outcome::Success, &mut next);

    let writes = s.node.take();
    let records = records(&writes);
    let types: Vec<&str> = records[1]
        .parts
        .iter()
        .map(|p| p["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        ["step-start", "reasoning", "tool", "text", "step-finish"],
        "每轮推理/正文在服务端调用之前落库"
    );
    let tool = &records[1].parts[2];
    assert_eq!(tool["metadata"]["providerExecuted"], true);
    assert_eq!(tool["metadata"]["providerCallBlock"], call);
    assert_eq!(tool["metadata"]["providerResultBlock"], result);
    assert_eq!(tool["state"]["status"], "completed");
    assert_eq!(tool["state"]["output"], "a cat");

    let canonical: Vec<Value> = hydrate(&records, &|_| None)
        .entries
        .iter()
        .map(|e| e.canonical())
        .collect();
    assert_eq!(
        canonical,
        vec![json!({"role": "user", "content": "search"}), live],
        "热历史与冷恢复的 canonical 必须一致（含轮次与原始结果块）"
    );
}

#[test]
fn session_features_are_written_as_a_sorted_last_wins_entry() {
    // 3.18 F12：能力标签 entry 与上游 `runtime/session_features` 同形，只增不减。
    let mut s = session();
    s.id = "sess_features".into();
    s.node.created = true;
    s.session_features.insert("tool_search_native".into());
    s.session_features.insert("browser_use".into());
    s.node_session_features(20);
    let writes = s.node.take();
    let entry = writes
        .iter()
        .find_map(|write| match &write.op {
            super::Op::Entry(entry) if entry["type"] == "runtime/session_features" => {
                Some(entry.clone())
            }
            _ => None,
        })
        .expect("session features entry");
    assert_eq!(entry["id"], "sess_features:runtime-session-features");
    assert_eq!(entry["touchSession"], false);
    assert_eq!(
        entry["data"],
        json!({"features": ["browser_use", "tool_search_native"]})
    );
    // 空集合不写空 entry（冷恢复按历史推导），也不覆盖已有 facts。
    let mut empty = session();
    empty.node.created = true;
    empty.node_session_features(21);
    assert!(empty.node.take().is_empty());
}
