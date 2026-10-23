//! Goal verifier 的 S6 回归：搜索后的验证请求也必须走同一引用投影。
use super::fixture::{Fixture, text_reply, tool_reply};
use super::harness;
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn goal_verification_projects_references_instead_of_raw_blocks() {
    let script = vec![
        tool_reply(
            "s1",
            "ToolSearch",
            json!({"query":"select:TodoWrite","max_results":5}),
        ),
        text_reply("Working."),
        text_reply(r#"{"passed":true,"reason":"done"}"#),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "native").await;
    let ack = h
        .command(
            2,
            json!({"commandId":"goal-1","clientId":"test","sessionId":session,
                "type":"sendGoalCommand","issuedAt":1,"payload":{"text":"deliver"}}),
        )
        .await;
    assert!(ack.get("error").is_none(), "{ack:#?}");
    h.wait_requests(3).await;

    let bodies = h.bodies();
    let verify = bodies
        .iter()
        .find(|body| {
            body.to_string()
                .contains("This is a verification request only.")
        })
        .unwrap_or_else(|| panic!("goal verification request: {bodies:#?}"));
    // 空工具目录自动降级 Off：引用移除占位、公告隐藏、不发送任何工具。
    let text = verify.to_string();
    assert!(!text.contains("\\\"tool_reference\\\""), "{verify:#?}");
    assert!(
        text.contains("[Tool references removed - tool search not enabled]"),
        "{verify:#?}"
    );
    assert!(
        !text.contains("The following deferred tools are now available via ToolSearch"),
        "{verify:#?}"
    );
    // Anthropic 编码在空目录时省略 tools 字段。
    assert!(
        verify.get("tools").is_none()
            || verify["tools"]
                .as_array()
                .is_some_and(|tools| tools.is_empty())
    );
    // 请求成功且判定来自 verifier JSON：不是 request_failed/fail-open。
    let conn = rusqlite::Connection::open(&h.db).unwrap();
    let mut last: (String, Option<String>) = (String::new(), None);
    for _ in 0..200 {
        last = conn
            .query_row(
                "select status, (select json_extract(data, '$.payload.verification.reason')
                   from session_entry where session_id = ?
                   and type = 'target_completion_verification'
                   order by time_created desc, rowid desc limit 1)
                 from session_target where session_id = ?",
                [&session, &session],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap_or_default();
        if last.0 == "complete" && last.1.as_deref() == Some("done") {
            h.close().await;
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("goal did not complete: {last:#?}\n{:#?}", h.bodies());
}
