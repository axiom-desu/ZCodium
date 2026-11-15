#![allow(dead_code)]
//! 3.18 F14 `CronPauseSelf` 的真实 Engine E2E。
//!
//! 真实 NodeStore SQLite、真实 WorkspaceTools、loopback provider 与真实的 Host 请求/回执帧。
//! 规范见 `.agents/specs/upstream-3.18-rust-native-parity-n5.md`。
#[path = "tool_search_e2e/fixture.rs"]
mod fixture;
#[path = "tool_search_e2e/harness.rs"]
mod harness;

use fixture::{Fixture, text_reply, tool_reply, tools};
use serde_json::{Value, json};
use std::sync::Arc;

const PAUSE: &str = "automation/pause";

fn tool_names(body: &Value) -> Vec<String> {
    tools(body).into_iter().map(|(name, _)| name).collect()
}

/// Host 准入的 automationId 与 inputId 前缀两条注入路径：工具可见，请求只带被准入的 id。
#[tokio::test]
async fn admitted_automation_id_is_the_only_pause_target() {
    let script = vec![
        tool_reply("s1", "CronPauseSelf", json!({})),
        text_reply("Paused the automation."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "off").await;
    h.send_automation(
        2,
        &session,
        "check the stop condition",
        Some("automation-42"),
        None,
    )
    .await;
    let host = h.wait_host_request(PAUSE).await;
    // strict schema：只有 automationId，没有 requestId/workspace/模型输入。
    assert_eq!(host["params"], json!({"automationId":"automation-42"}));
    h.host_reply(host["id"].as_str().unwrap(), json!({"paused":true}))
        .await;
    h.settled(&session, 1).await;

    let bodies = h.bodies();
    let names = tool_names(&bodies[0]);
    assert!(
        names.iter().any(|name| name == "CronPauseSelf"),
        "{names:?}"
    );
    // 结果回到模型：真实暂停文案。
    assert!(
        bodies[1].to_string().contains(
            "Paused automation automation-42. It will not run on schedule until the user resumes it."
        ),
        "{:#?}",
        bodies[1]
    );
    assert_eq!(h.host_requests(PAUSE).len(), 1);
}

#[tokio::test]
async fn automation_input_id_prefix_is_the_same_trusted_identity() {
    let script = vec![
        tool_reply("s1", "CronPauseSelf", json!({})),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "off").await;
    // 没有显式 payload.automationId：执行轮身份由 inputId 前缀解析（Node resolveTurnAutomationId）。
    h.send_automation(
        2,
        &session,
        "stop condition met",
        None,
        Some("automation-77:run:3"),
    )
    .await;
    let host = h.wait_host_request(PAUSE).await;
    assert_eq!(host["params"], json!({"automationId":"automation-77"}));
    // Host 自己判断它已不在活动状态：结论是 false，不是失败。
    h.host_reply(host["id"].as_str().unwrap(), json!({"paused":false}))
        .await;
    h.settled(&session, 1).await;
    let bodies = h.bodies();
    assert!(
        bodies[1].to_string().contains(
            "Automation automation-77 is not active (already paused, completed, failed, or deleted), so nothing changed."
        ),
        "{:#?}",
        bodies[1]
    );
}

/// 普通用户轮：工具不注册；即使模型强行调用，身份门先失败且不发 Host 请求。
#[tokio::test]
async fn user_turn_hides_the_tool_and_refuses_without_a_host_request() {
    let script = vec![
        tool_reply("s1", "CronPauseSelf", json!({})),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "off").await;
    h.send(2, &session, "just a normal turn").await;
    h.settled(&session, 1).await;

    let bodies = h.bodies();
    let names = tool_names(&bodies[0]);
    assert!(
        !names.iter().any(|name| name == "CronPauseSelf"),
        "{names:?}"
    );
    assert!(
        bodies[1]
            .to_string()
            .contains("CronPauseSelf is only available while running a scheduled automation.")
    );
    assert!(h.host_requests(PAUSE).is_empty());
}

/// 模型伪造目标 id：严格空 schema 拒绝，绝不把参数当暂停对象。
#[tokio::test]
async fn forged_target_in_the_tool_input_never_reaches_the_host() {
    let script = vec![
        tool_reply(
            "s1",
            "CronPauseSelf",
            json!({"automationId":"automation-evil"}),
        ),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "off").await;
    h.send_automation(2, &session, "check", Some("automation-42"), None)
        .await;
    h.settled(&session, 1).await;
    let bodies = h.bodies();
    let result = bodies[1].to_string();
    assert!(result.contains("automationId"), "{result}");
    assert!(!result.contains("Paused automation"), "{result}");
    assert!(h.host_requests(PAUSE).is_empty());
}

/// Host 拒绝/不支持（协议把错误回执投影成空）：工具失败，不得伪造暂停成功。
#[tokio::test]
async fn host_rejection_is_not_a_silent_pause() {
    let script = vec![
        tool_reply("s1", "CronPauseSelf", json!({})),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "off").await;
    h.send_automation(2, &session, "check", Some("automation-42"), None)
        .await;
    let host = h.wait_host_request(PAUSE).await;
    // 旧 Host 的 -32601 / automationOwner 拒绝的 -32602 在传输层都落到空结果。
    h.host_reply(host["id"].as_str().unwrap(), Value::Null)
        .await;
    h.settled(&session, 1).await;
    let bodies = h.bodies();
    let result = bodies[1].to_string();
    assert!(
        result.contains("automation/pause was rejected or failed on the Host"),
        "{result}"
    );
    assert!(!result.contains("Paused automation"), "{result}");
}

/// 冷恢复：暂停身份不落库，重开后的普通轮仍然不注册该工具。
#[tokio::test]
async fn cold_resume_does_not_carry_the_automation_identity() {
    let script = vec![
        tool_reply("s1", "CronPauseSelf", json!({})),
        text_reply("Paused."),
        text_reply("Plain turn."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "off").await;
    h.send_automation(2, &session, "check", Some("automation-9"), None)
        .await;
    let host = h.wait_host_request(PAUSE).await;
    h.host_reply(host["id"].as_str().unwrap(), json!({"paused":true}))
        .await;
    h.settled(&session, 1).await;

    let (root, dir) = h.close().await;
    let mut reopened = harness::Harness::start_root(fixture.clone(), root, dir).await;
    let reply = reopened
        .request(
            3,
            "session/resume",
            json!({"sessionId": session, "runtimeConfig": {"toolSearch": {"mode": "off"}}}),
        )
        .await;
    assert_eq!(reply["result"]["session"]["sessionId"], session);
    let before = fixture.requests();
    reopened.send(4, &session, "plain follow up").await;
    reopened.wait_requests(before + 1).await;
    let bodies = reopened.bodies();
    let last = bodies.last().cloned().unwrap_or(Value::Null);
    let names = tool_names(&last);
    assert!(
        !names.iter().any(|name| name == "CronPauseSelf"),
        "{names:?}"
    );
    reopened.close().await;
}
