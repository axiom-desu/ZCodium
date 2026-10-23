use super::*;
use crate::domain::usage::{Tokens, ToolFact, TurnFact};

fn tool(status: &'static str, started_at: u64, duration: Option<u64>) -> Fact {
    Fact::Tool(Box::new(ToolFact {
        session_id: "s".into(),
        tool_call_id: "c".into(),
        tool_name: "Bash".into(),
        approval_status: "none",
        status,
        started_at,
        duration_ms: duration,
        ..ToolFact::default()
    }))
}

#[test]
fn upserts_merge_like_node_and_pruning_drops_old_rows() {
    // Node 迁移后的库（`0010_usage_observability`）。
    let dir = tempfile::tempdir().unwrap();
    let conn = crate::node::open::open(
        &dir.path().join("db.sqlite"),
        crate::node::open::BUSY_TIMEOUT,
        &mut |_| {},
    )
    .unwrap();
    let session = crate::node::sessions::Create {
        id: "s".into(),
        project_id: "proj_w".into(),
        slug: "s".into(),
        directory: "/w".into(),
        title: "t".into(),
        version: "0".into(),
        ..Default::default()
    };
    crate::node::sessions::create(&conn, &session, 1).unwrap();
    let mut writer = Writer::new("");
    let now = 40 * 86_400_000;
    writer
        .record(&conn, &tool("running", now - 10, None), now)
        .unwrap();
    writer
        .record(&conn, &tool("completed", now - 5, Some(7)), now)
        .unwrap();
    // 迟到的 running 不能覆盖终态，开始时间取最早值。
    writer
        .record(&conn, &tool("running", now - 1, None), now)
        .unwrap();
    let row: (String, i64, Option<i64>) = conn
        .query_row(
            "SELECT status,started_at,duration_ms FROM tool_usage",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, ("completed".into(), (now - 10) as i64, Some(7)));
    let turn = |started_at: u64, status: &'static str| {
        Fact::Turn(Box::new(TurnFact {
            session_id: "s".into(),
            turn_id: "t".into(),
            status,
            started_at,
            completed_at: started_at + 100,
            tokens: Tokens {
                input: 3,
                ..Tokens::default()
            },
            ..TurnFact::default()
        }))
    };
    writer.record(&conn, &turn(now - 50, "error"), now).unwrap();
    writer
        .record(&conn, &turn(now - 20, "completed"), now)
        .unwrap();
    let merged: (String, i64, i64) = conn
        .query_row(
            "SELECT status,started_at,input_tokens FROM turn_usage",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(merged, ("completed".into(), (now - 50) as i64, 3));
    let Fact::Tool(mut old) = tool("completed", 1, None) else {
        unreachable!()
    };
    old.tool_call_id = "old".into();
    writer.record(&conn, &Fact::Tool(old), now).unwrap();
    prune(&conn, "", now - RETENTION_MS).unwrap();
    let left: i64 = conn
        .query_row("SELECT count(*) FROM tool_usage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 1, "the old row is gone, the recent one stays");
}

#[test]
fn failed_request_usage_survives_reopen_as_one_durable_fact() {
    use crate::domain::usage::{ModelFact, Tokens};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let now = 40 * 86_400_000;
    let usage =
        serde_json::json!({"inputTokens": 120000, "outputTokens": 0, "totalTokens": 120000});
    let fact = Fact::Model(Box::new(ModelFact {
        session_id: "s".into(),
        query_source: "main_turn".into(),
        status: "error",
        started_at: now - 10,
        completed_at: now,
        context_exceeded: true,
        tokens: Tokens::from_usage(&usage),
        provider_total_tokens: Some(120000),
        raw_usage: Some(usage.clone()),
        ..ModelFact::default()
    }));
    {
        let conn =
            crate::node::open::open(&path, crate::node::open::BUSY_TIMEOUT, &mut |_| {}).unwrap();
        // 用量行有会话外键：先写最小会话行，再写用量事实。
        crate::node::sessions::create(
            &conn,
            &crate::node::sessions::Create {
                directory: "/w".into(),
                id: "s".into(),
                project_id: "proj_w".into(),
                slug: "s".into(),
                title: "t".into(),
                version: "0".into(),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        // 与生产 store 一致：用量写进 Node 迁移 0010 建的表（prefix 空）。
        let mut writer = Writer::new("");
        writer.record(&conn, &fact, now).unwrap();
        // 重复收口同一事实不新增行（主键 id 不变）。
        writer.record(&conn, &fact, now).unwrap();
    }
    // 冷恢复：关库重开，失败请求的 usage 仍是唯一一条持久事实。
    let conn =
        crate::node::open::open(&path, crate::node::open::BUSY_TIMEOUT, &mut |_| {}).unwrap();
    let rows: Vec<(String, i64, i64, Option<String>, i64)> = {
        let mut stmt = conn
            .prepare("SELECT status,input_tokens,computed_total_tokens,raw_usage_json,context_exceeded FROM model_usage")
            .unwrap();
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    };
    assert_eq!(rows.len(), 1, "one durable fact per request: {rows:?}");
    assert_eq!(rows[0].0, "error");
    assert_eq!((rows[0].1, rows[0].2, rows[0].4), (120000, 120000, 1));
    assert_eq!(
        rows[0]
            .3
            .as_deref()
            .map(|raw| serde_json::from_str::<serde_json::Value>(raw).unwrap()),
        Some(usage)
    );
}
