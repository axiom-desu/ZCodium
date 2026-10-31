//! Actual MCP transport: numeric InvalidParams versus response/transport failures.
use super::{EXPLANATION, call, fixture, harness, parts, result};
use fixture::{Fixture, text_reply, tool_reply};
use serde_json::json;
use std::sync::Arc;

const TOOL: &str = "mcp__input_fixture__probe";

async fn create(h: &mut harness::Harness, mode: &str) -> String {
    let script = h.root.join("server.py");
    tokio::fs::write(&script, include_str!("mcp_server.py"))
        .await
        .unwrap();
    let reply = h
        .request(
            1,
            "session/create",
            json!({
                "workspace":{"workspacePath": h.workspace, "workspaceKey": h.workspace},
                "mode":"yolo", "runtimeConfig":{"toolSearch":{"mode":mode}},
                "mcpServers":[{"name":"input_fixture","command":"python3",
                    "args":[script, h.root], "env":[], "timeoutMs":2000}]
            }),
        )
        .await;
    assert!(reply.get("result").is_some(), "create: {reply}");
    reply["result"]["session"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_owned()
}

#[tokio::test]
async fn mcp_invalid_params_guides_load_and_retry_effect_once() {
    for mode in ["native", "local"] {
        let fixture = Arc::new(
            Fixture::start(vec![
                call(mode, "bad", TOOL, json!({"count":"1"})),
                tool_reply(
                    "load",
                    "ToolSearch",
                    json!({"query":format!("select:{TOOL}")}),
                ),
                call(mode, "retry", TOOL, json!({"count":1})),
                text_reply("done"),
            ])
            .await,
        );
        let mut h = harness::Harness::start(fixture).await;
        let session = create(&mut h, mode).await;
        h.send(2, &session, "count once").await;
        let conn = h.settled(&session, 1).await;
        let bodies = h.bodies();
        assert_eq!(bodies.len(), 4);
        let error = result(&bodies[1], "bad");
        assert!(
            error.contains("count must be numeric") && error.contains(EXPLANATION),
            "{error}"
        );
        assert!(
            error.contains(&format!("query \"select:{TOOL}\"")),
            "{error}"
        );
        assert_eq!(
            tokio::fs::read_to_string(h.root.join("effects"))
                .await
                .unwrap(),
            "1\n"
        );
        let calls = tokio::fs::read_to_string(h.root.join("calls"))
            .await
            .unwrap();
        assert_eq!(
            calls.lines().count(),
            2,
            "one bad call, one good call, no duplicate execution"
        );
        let rows = parts(&conn, &session);
        assert_eq!(rows.iter().filter(|row| row["tool"] == TOOL).count(), 2);
        let bad = rows.iter().find(|row| row["callID"] == "bad").unwrap();
        assert_eq!(bad["tool"], TOOL);
        assert_eq!(bad["state"]["input"], json!({"count":"1"}));
        assert!(bad["state"].to_string().contains(EXPLANATION.trim()));
        assert_eq!(bad["state"]["status"], "error");
        h.close().await;
    }
}

#[tokio::test]
async fn mcp_transport_exit_internal_and_response_json_failures_have_no_hint() {
    for failure in ["disconnect", "response-json", "internal", "is-error"] {
        let fixture = Arc::new(
            Fixture::start(vec![
                tool_reply("fail", TOOL, json!({"count":1,"failure":failure})),
                text_reply("done"),
            ])
            .await,
        );
        let mut h = harness::Harness::start(fixture).await;
        let session = create(&mut h, "native").await;
        h.send(2, &session, "fail without loading").await;
        let conn = h.settled(&session, 1).await;
        let rows = parts(&conn, &session);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["state"]["status"], "error", "{failure}: {rows:#?}");
        let error = result(&h.bodies()[1], "fail");
        assert!(
            !error.contains(EXPLANATION) && !error.contains("Load the tool first:"),
            "{failure}: {error}"
        );
        assert!(!h.root.join("effects").exists());
        assert_eq!(
            tokio::fs::read_to_string(h.root.join("calls"))
                .await
                .unwrap()
                .lines()
                .count(),
            1
        );
        h.close().await;
    }
}
