//! 回包校验：缺失/非法字段是“未知 + 可见错误”，不得伪造成功或补零（spec §3）。
#![allow(clippy::field_reassign_with_default)]

use crate::{client::QueryKind, client_reads::ReadReply, projection::View, telemetry};
use serde_json::{Value, json};
use zcode_cli_core_api::RuntimeError;

fn view() -> View {
    let mut view = View::default();
    view.snapshot(&json!({"sessionId":"s","seq":0,"rows":{"window":[]},
        "control":{"canStop":false,"phase":"draft"},"config":{"mode":"build"},"pendingInteractions":[]}));
    view
}

fn reply(view: &View, kind: QueryKind, result: Result<Value, RuntimeError>) -> ReadReply {
    ReadReply {
        kind,
        session: view.session.clone(),
        generation: view.generation,
        result,
    }
}

fn apply(view: &mut View, kind: QueryKind, result: Result<Value, RuntimeError>) {
    let reply = reply(view, kind, result);
    telemetry::apply_reply(view, reply);
}

fn connected(count: u64) -> Value {
    json!({"status":"connected","transport":"stdio","toolCount":count})
}

/// 缺 `statuses` 对象不是“空结果”：保留 last known 并显式报错。
#[test]
fn mcp_reply_without_statuses_keeps_the_last_known_state() {
    let mut view = view();
    apply(
        &mut view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":{"fs":connected(2)}})),
    );
    assert_eq!(view.telemetry.mcp_total, 1);
    assert_eq!(view.telemetry.mcp_connected, 1);
    let notices = view.notices.len();

    apply(&mut view, QueryKind::McpStatus, Ok(json!({"servers":[]})));
    assert_eq!(view.telemetry.mcp_total, 1);
    assert_eq!(view.telemetry.mcp_servers.len(), 1);
    assert_eq!(
        view.telemetry.mcp_error.as_deref(),
        Some("MCP status reply has no statuses object")
    );
    assert!(view.notices.len() > notices, "failure must stay visible");
}

/// 未知状态值不能当成功行展示，也不能把已有状态洗成“空”。
#[test]
fn invalid_status_kind_is_an_error_not_a_row() {
    let mut view = view();
    apply(
        &mut view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":{"fs":connected(2)}})),
    );
    apply(
        &mut view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":{"fs":{"status":"bogus","toolCount":1}}})),
    );
    assert_eq!(view.telemetry.mcp_servers.len(), 1);
    assert_eq!(view.telemetry.mcp_servers[0].status, "connected");
    let error = view.telemetry.mcp_error.clone().unwrap_or_default();
    assert!(error.contains("unknown status bogus"), "{error}");
}

/// 没有 `toolCount` 就是“未知”，不能编一个 0 顶替真实工具数。
#[test]
fn missing_tool_count_stays_unknown_instead_of_zero() {
    let mut view = view();
    apply(
        &mut view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":{
            "fs":{"status":"connected","transport":"stdio"},
            "broken":{"status":"failed","transport":"http","toolCount":3}
        }})),
    );
    assert_eq!(view.telemetry.mcp_error, None);
    let fs = view
        .telemetry
        .mcp_servers
        .iter()
        .find(|server| server.name == "fs")
        .expect("fs row");
    assert_eq!(fs.tool_count, None);
    let broken = view
        .telemetry
        .mcp_servers
        .iter()
        .find(|server| server.name == "broken")
        .expect("broken row");
    assert_eq!(broken.tool_count, Some(3));

    // 字段存在但类型不对是坏报文，不是“未知”。
    apply(
        &mut view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":{"fs":{"status":"connected","toolCount":"2"}}})),
    );
    let error = view.telemetry.mcp_error.clone().unwrap_or_default();
    assert!(error.contains("invalid toolCount"), "{error}");
}

/// 完整 map 的真实总数/连接数在截断前统计，缓存只保存前 32 个细项。
#[test]
fn mcp_totals_come_from_the_full_map_before_caching() {
    let mut view = view();
    let mut statuses = serde_json::Map::new();
    for index in 0..40 {
        let status = if index % 2 == 0 {
            connected(1)
        } else {
            json!({"status":"disabled","transport":"http","toolCount":0})
        };
        statuses.insert(format!("server-{index:02}"), status);
    }
    apply(
        &mut view,
        QueryKind::McpStatus,
        Ok(json!({"statuses":statuses})),
    );
    assert_eq!(view.telemetry.mcp_total, 40);
    assert_eq!(view.telemetry.mcp_connected, 20);
    assert_eq!(view.telemetry.mcp_servers.len(), 32);
    assert_eq!(view.telemetry.mcp_servers[0].name, "server-00");
    assert_eq!(view.telemetry.mcp_servers[31].name, "server-31");
}

/// usage 必须带同会话的真实数字；缺字段/错会话是错误，不能按 0 累计。
#[test]
fn usage_requires_real_numbers_and_the_session_id() {
    let mut view = view();
    apply(
        &mut view,
        QueryKind::Usage,
        Ok(
            json!({"sessionId":"other","totalTokens":9,"inputTokens":4,"outputTokens":5,
            "reasoningTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0}),
        ),
    );
    assert!(view.telemetry.usage.is_none());
    assert!(view.telemetry.usage_error.is_some());

    apply(
        &mut view,
        QueryKind::Usage,
        Ok(json!({"sessionId":"s","totalTokens":9})),
    );
    assert!(view.telemetry.usage.is_none());
    let error = view.telemetry.usage_error.clone().unwrap_or_default();
    assert!(error.contains("inputTokens"), "{error}");

    apply(
        &mut view,
        QueryKind::Usage,
        Ok(json!({"totalTokens":9,"inputTokens":4,"outputTokens":5,
            "reasoningTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0})),
    );
    assert!(view.telemetry.usage.is_none());
    assert!(view.telemetry.usage_error.is_some());

    apply(
        &mut view,
        QueryKind::Usage,
        Ok(
            json!({"sessionId":"s","totalTokens":9,"inputTokens":4,"outputTokens":5,
            "reasoningTokens":1,"cacheReadTokens":2,"cacheCreationTokens":3}),
        ),
    );
    let usage = view.telemetry.usage.expect("real usage");
    assert_eq!((usage.total, usage.input, usage.output), (9, 4, 5));
    assert_eq!(
        (usage.reasoning, usage.cache_read, usage.cache_write),
        (1, 2, 3)
    );
    assert_eq!(view.telemetry.usage_error, None);
}

/// 失败回包保留上一次真实数字，只标错误并提示，不回退成 0。
#[test]
fn invalid_usage_keeps_the_last_real_value() {
    let mut view = view();
    apply(
        &mut view,
        QueryKind::Usage,
        Ok(
            json!({"sessionId":"s","totalTokens":9,"inputTokens":4,"outputTokens":5,
            "reasoningTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0}),
        ),
    );
    let notices = view.notices.len();
    apply(
        &mut view,
        QueryKind::Usage,
        Err(RuntimeError::Fault {
            message: "usage store busy".into(),
            code: None,
        }),
    );
    assert_eq!(view.telemetry.usage.map(|usage| usage.total), Some(9));
    assert_eq!(
        view.telemetry.usage_error.as_deref(),
        Some("usage store busy")
    );
    assert!(view.notices.len() > notices);
}
