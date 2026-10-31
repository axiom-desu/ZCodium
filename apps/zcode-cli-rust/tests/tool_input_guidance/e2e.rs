//! Frozen S6 input guidance: real Engine, loopback model, SQLite and actual Todo owner.
use super::{fixture, harness};
#[cfg(unix)]
#[path = "mcp.rs"]
mod mcp;

use fixture::{Fixture, text_reply, tool_reply};
use serde_json::{Value, json};
use std::sync::Arc;

const EXPLANATION: &str = "\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ";

fn call(mode: &str, id: &str, name: &str, input: Value) -> String {
    if mode == "local" {
        tool_reply(id, "DeferredToolCall", json!({"name":name,"input":input}))
    } else {
        tool_reply(id, name, input)
    }
}

fn parts(conn: &rusqlite::Connection, session: &str) -> Vec<Value> {
    conn.prepare("select data from part where session_id = ? and json_extract(data, '$.type') = 'tool' order by sequence")
        .unwrap().query_map([session], |row| row.get::<_, String>(0)).unwrap()
        .map(|row| serde_json::from_str(&row.unwrap()).unwrap()).collect()
}

fn result(body: &Value, id: &str) -> String {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|block| block["type"] == "tool_result" && block["tool_use_id"] == id)
        .expect("model receives tool result")["content"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|message| message["content"].as_array().into_iter().flatten())
                .find(|block| block["type"] == "tool_result" && block["tool_use_id"] == id)
                .unwrap()["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
}

#[tokio::test]
async fn invalid_deferred_todo_guides_search_then_commits_exactly_once() {
    for mode in ["native", "local"] {
        let valid =
            json!({"todos":[{"content":"one actual commit","status":"pending","priority":"high"}]});
        let fixture = Arc::new(
            Fixture::start(vec![
                call(mode, "bad", "TodoWrite", json!({"todos":"[]"})),
                tool_reply("search", "ToolSearch", json!({"query":"select:TodoWrite"})),
                call(mode, "good", "TodoWrite", valid.clone()),
                // Once discovered, the same definite failure must NOT repeat the hint.
                call(mode, "known-bad", "TodoWrite", json!({"todos":"[]"})),
                text_reply("done"),
            ])
            .await,
        );
        let mut h = harness::Harness::start(fixture).await;
        let session = h.create(1, mode).await;
        h.send(2, &session, "update checklist").await;
        let conn = h.settled(&session, 1).await;
        let bodies = h.bodies();
        assert_eq!(bodies.len(), 5);
        let text = result(&bodies[1], "bad");
        assert!(
            text.contains("invalid type: string"),
            "original cause: {text}"
        );
        let schemas: Value =
            serde_json::from_str(include_str!("../../crates/tools/src/tool_schemas.json")).unwrap();
        let schema = &schemas["TodoWrite"];
        let expected = format!(
            "{EXPLANATION}Load the tool first: call ToolSearch with query \"select:TodoWrite\", then retry this call. For reference, this tool's input schema is: {}{}",
            zcode_cli_domain::js_json::stringify(schema),
            if mode == "local" {
                "\nCall DeferredToolCall with {name: \"TodoWrite\", input: {...}}."
            } else {
                ""
            }
        );
        assert!(text.ends_with(&expected), "{text}");
        assert!(!result(&bodies[4], "known-bad").contains(EXPLANATION));
        let rows = parts(&conn, &session);
        let bad = rows.iter().find(|row| row["callID"] == "bad").unwrap();
        assert_eq!(bad["tool"], "TodoWrite");
        assert_eq!(bad["state"]["status"], "error");
        assert_eq!(bad["state"]["input"], json!({"todos":"[]"}));
        assert!(
            bad["state"].to_string().contains(EXPLANATION.trim()),
            "UI durable failure includes correction: {bad}"
        );
        if mode == "local" {
            assert_eq!(bad["metadata"]["modelCallWrapper"], "DeferredToolCall");
        }
        let successful: Vec<_> = rows
            .iter()
            .filter(|row| row["tool"] == "TodoWrite" && row["state"]["status"] == "completed")
            .collect();
        assert_eq!(
            successful.len(),
            1,
            "one successful target execution: {rows:#?}"
        );
        assert_eq!(successful[0]["callID"], "good");
        let output = result(&bodies[3], "good");
        assert!(
            output.contains("one actual commit") && output.contains("\"oldTodos\":[]"),
            "actual owner effect once: {output}"
        );
        h.close().await;
    }
}

#[tokio::test]
async fn permission_network_and_exit_failures_do_not_suggest_loading_a_schema() {
    for (mode, name, args) in [
        (
            "plan",
            "WebFetch",
            json!({"url":"https://example.invalid/","prompt":"read"}),
        ),
        (
            "yolo",
            "WebFetch",
            json!({"url":"http://127.0.0.1:1/","prompt":"read"}),
        ),
        ("yolo", "Bash", json!({"command":"exit 1"})),
    ] {
        let fixture = Arc::new(
            Fixture::start(vec![tool_reply("fail", name, args), text_reply("done")]).await,
        );
        let mut h = harness::Harness::start(fixture).await;
        let session = h.create_mode(1, mode, "native").await;
        h.send(2, &session, "try tool").await;
        let conn = h.settled(&session, 1).await;
        let rows = parts(&conn, &session);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["state"]["status"], "error", "{rows:#?}");
        let bodies = h.bodies();
        let text = result(&bodies[1], "fail");
        assert!(
            !text.contains(EXPLANATION) && !text.contains("Load the tool first:"),
            "{text}"
        );
        h.close().await;
    }
}

#[tokio::test]
async fn plan_input_failure_is_typed_before_approval_in_native_and_local() {
    for mode in ["native", "local"] {
        let fixture = Arc::new(
            Fixture::start(vec![
                call(mode, "bad-plan", "ExitPlanMode", json!({"plan":7})),
                text_reply("done"),
            ])
            .await,
        );
        let mut h = harness::Harness::start(fixture).await;
        let session = h.create_mode(1, "plan", mode).await;
        h.send(2, &session, "invalid plan").await;
        let conn = h.settled(&session, 1).await;
        let error = result(&h.bodies()[1], "bad-plan");
        assert!(
            error.starts_with("plan: Invalid input: expected string\n\n"),
            "{error}"
        );
        assert!(error.contains(EXPLANATION) && error.contains("select:ExitPlanMode"));
        let rows = parts(&conn, &session);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["tool"], "ExitPlanMode");
        assert_eq!(rows[0]["state"]["status"], "error");
        h.close().await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_target_keeps_pre_and_failure_hooks_and_original_call_identity() {
    let fixture = Arc::new(
        Fixture::start(vec![
            call("local", "bad", "TodoWrite", json!({"todos":"[]"})),
            tool_reply("load", "ToolSearch", json!({"query":"select:TodoWrite"})),
            call("local", "retry", "TodoWrite", json!({"todos":[]})),
            text_reply("done"),
        ])
        .await,
    );
    let dir = Arc::new(tempfile::tempdir().unwrap());
    let registration = json!([{"matcher":"TodoWrite", "hooks":[{
        "type":"command", "command":"cat >> hook-inputs.jsonl", "timeout":5
    }]}]);
    let hooks = json!({"enabled":true, "events":{"PreToolUse":registration, "PostToolUseFailure":registration, "PostToolUse":registration}});
    let mut h =
        harness::Harness::start_with_hooks(fixture, dir.path().into(), Some(dir.clone()), hooks)
            .await;
    let session = h.create(1, "local").await;
    h.send(2, &session, "test hooks").await;
    h.settled(&session, 1).await;
    let text =
        tokio::fs::read_to_string(std::path::Path::new(&h.workspace).join("hook-inputs.jsonl"))
            .await
            .unwrap();
    let hooks: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let events: Vec<_> = hooks
        .iter()
        .map(|hook| {
            (
                hook["hookEventName"].as_str().unwrap(),
                hook["toolCallId"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        events,
        [
            ("PreToolUse", "bad"),
            ("PostToolUseFailure", "bad"),
            ("PreToolUse", "retry"),
            ("PostToolUse", "retry")
        ]
    );
    assert!(hooks.iter().all(|hook| hook["toolName"] == "TodoWrite"));
    assert_eq!(hooks[0]["toolInput"], json!({"todos":"[]"}));
    assert!(
        hooks[1]["error"]
            .to_string()
            .contains("invalid type: string")
    );
    assert!(
        !hooks[1]["error"]
            .to_string()
            .contains("Load the tool first:"),
        "failure hook sees original cause, not appended guidance"
    );
    h.close().await;
}

#[tokio::test]
async fn off_mode_and_resident_input_errors_do_not_get_guidance() {
    for (mode, name, args) in [
        ("off", "TodoWrite", json!({"todos":"[]"})),
        (
            "native",
            "Write",
            json!({"file_path":1,"content":"no write"}),
        ),
        (
            "local",
            "DeferredToolCall",
            json!({"name":"Write","input":{}}),
        ),
    ] {
        let fixture =
            Arc::new(Fixture::start(vec![tool_reply("bad", name, args), text_reply("done")]).await);
        let mut h = harness::Harness::start(fixture).await;
        let session = h.create(1, mode).await;
        h.send(2, &session, "invalid").await;
        h.settled(&session, 1).await;
        assert!(!result(&h.bodies()[1], "bad").contains(EXPLANATION));
        h.close().await;
    }
}
