//! S6 real-engine E2E: real Rust engine + loopback HTTP + temporary NodeStore SQLite.
#[path = "tool_search_e2e/fixture.rs"]
mod fixture;
#[path = "tool_search_e2e/goal.rs"]
mod goal;
#[path = "tool_search_e2e/harness.rs"]
mod harness;
#[path = "tool_input_guidance/e2e.rs"]
mod input_guidance;

use fixture::{Fixture, text_reply, tool_reply, tools};
use serde_json::{Value, json};
use std::sync::Arc;

#[tokio::test]
async fn native_search_loads_schema_marks_outside_batch_and_survives_reopen() {
    let script = vec![
        tool_reply(
            "s1",
            "ToolSearch",
            json!({"query":"select:TodoWrite","max_results":5}),
        ),
        tool_reply(
            "s2",
            "TodoWrite",
            json!({"todos":[{"content":"ship","status":"pending","priority":"high"}]}),
        ),
        text_reply("Done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "native").await;
    h.send(2, &session, "load todo").await;
    h.settled(&session, 1).await;

    let bodies = h.bodies();
    assert_eq!(bodies.len(), 3, "{bodies:#?}");
    let first = tools(&bodies[0]);
    assert!(
        first.iter().any(|(name, _)| name == "ToolSearch"),
        "{:#?}",
        bodies[0]
    );
    assert!(!first.iter().any(|(name, _)| name == "TodoWrite"));
    // 第二轮请求带已发现的 TodoWrite schema 且标 defer_loading。
    let second = tools(&bodies[1]);
    assert!(
        second.contains(&("TodoWrite".to_owned(), true)),
        "{second:?}"
    );
    // Native 成功提示位于 tool_result 批次之外：结果消息后紧跟独立 user 消息。
    let messages = bodies[1]["messages"].as_array().unwrap();
    let tool_result = messages
        .iter()
        .position(|message| {
            message["content"]
                .as_array()
                .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"))
        })
        .expect("tool_result");
    // Anthropic 合并相邻 user 消息；提示必须是 tool_result 的兄弟文本块，
    // 不能写进 tool_result 的 content 里。
    let blocks = messages[tool_result]["content"].as_array().unwrap();
    let marker = blocks
        .iter()
        .position(|block| block["type"] == "text" && block["text"] == "Tool loaded.")
        .expect("Tool loaded. marker");
    assert!(marker > 0, "marker after tool_result");
    let refs: Vec<&str> = blocks
        .iter()
        .filter(|block| block["type"] == "tool_result")
        .flat_map(|block| block["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "tool_reference")
        .filter_map(|block| block["tool_name"].as_str())
        .collect();
    assert_eq!(refs, vec!["TodoWrite"]);
    assert!(
        !blocks
            .iter()
            .filter(|block| block["type"] == "tool_result")
            .any(|block| block["content"].to_string().contains("Tool loaded."))
    );
    // 第三轮包含真实 TodoWrite 结果。
    assert!(bodies[2].to_string().contains("ship"));

    // 关闭 SQLite/引擎，重开后冷恢复下一请求仍带发现 schema 与引用。
    let (root, dir) = h.close().await;
    let mut reopened = harness::Harness::start_root(fixture.clone(), root, dir).await;
    let reply = reopened
        .request(
            3,
            "session/resume",
            json!({"sessionId": session, "runtimeConfig": {"toolSearch": {"mode": "native"}}}),
        )
        .await;
    assert_eq!(reply["result"]["session"]["sessionId"], session);
    // 冷恢复后再跑一个真实工具批次：公告增量 metadata 必须随历史恢复，
    // 否则正常收集会重复公告。
    fixture.push(tool_reply(
        "r1",
        "TodoWrite",
        json!({"todos":[{"content":"again","status":"pending","priority":"high"}]}),
    ));
    fixture.push(text_reply("Again."));
    reopened.send(4, &session, "again").await;
    reopened.settled(&session, 2).await;
    let bodies = reopened.bodies();
    let last = bodies.last().unwrap();
    assert!(tools(last).contains(&("TodoWrite".to_owned(), true)));
    assert!(last.to_string().contains("Tool loaded."));
    // 公告是持久事实：冷恢复后只出现一次，不能因重开或工具批次而重复。
    assert_eq!(
        last.to_string()
            .matches("The following deferred tools are now available via ToolSearch")
            .count(),
        1
    );
    reopened.close().await;
}

#[tokio::test]
async fn local_wraps_targets_rejects_resident_and_promotes_after_compact() {
    let script = vec![
        tool_reply(
            "s1",
            "ToolSearch",
            json!({"query":"select:TodoWrite","max_results":5}),
        ),
        tool_reply(
            "s2",
            "DeferredToolCall",
            json!({"name":"Write","input":{"file_path":"blocked.txt","content":"no"}}),
        ),
        tool_reply(
            "s3",
            "DeferredToolCall",
            json!({"name":"TodoWrite","input":{"todos":[
                {"content":"ship","status":"pending","priority":"high"}]}}),
        ),
        text_reply("Done."),
        text_reply("Compact summary."),
        text_reply("After compact."),
        text_reply("After reopen."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "local").await;
    h.send(2, &session, "load todo").await;
    h.settled(&session, 1).await;

    let bodies = h.bodies();
    eprintln!("BODY_COUNT={}", bodies.len());
    assert_eq!(bodies.len(), 4, "{bodies:#?}");
    // Local 只发常驻 + 两个控制入口，目标 schema 在真实结果位置展开。
    let second = tools(&bodies[1]);
    assert!(second.iter().any(|(name, _)| name == "ToolSearch"));
    assert!(second.iter().any(|(name, _)| name == "DeferredToolCall"));
    assert!(!second.iter().any(|(name, _)| name == "TodoWrite"));
    let text = bodies[1].to_string();
    assert!(text.contains("<functions>") && text.contains("\\\"name\\\":\\\"TodoWrite\\\""));
    assert!(text.contains("Call it now with DeferredToolCall"));
    // 常驻目标包装调用返回普通错误且零执行。
    assert!(!h.workspace.is_empty());
    assert!(
        !std::path::Path::new(&h.workspace)
            .join("blocked.txt")
            .exists()
    );
    assert!(bodies[2].to_string().contains("Call Write directly"));
    // 真实目标经同一 callID 执行。
    assert!(bodies[3].to_string().contains("ship"));
    // 持久 tool part 使用目标名 + 完整内层 input，包装标记只在 metadata。
    let conn = h.settled(&session, 1).await;
    let parts: Vec<Value> = conn
        .prepare(
            "select data from part where session_id = ?
             and json_extract(data, '$.type') = 'tool' order by sequence",
        )
        .unwrap()
        .query_map([&session], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| serde_json::from_str(&row.unwrap()).unwrap())
        .collect();
    let target = parts
        .iter()
        .find(|part| part["callID"] == "s3")
        .expect("wrapped target part");
    assert_eq!(target["tool"], "TodoWrite");
    assert_eq!(target["metadata"]["modelCallWrapper"], "DeferredToolCall");
    assert_eq!(target["state"]["input"]["todos"][0]["content"], "ship");
    // 准入失败的包装仍是 DeferredToolCall，且没有目标 part。
    assert!(
        parts
            .iter()
            .any(|part| part["callID"] == "s2" && part["tool"] == "DeferredToolCall")
    );

    let compact = h.compact(3, &session).await;
    assert_eq!(
        compact["result"]["compact"]["state"], "accepted",
        "{compact:#?}"
    );
    h.wait_summary(&session).await;
    // compact 摘要请求复用同一投影：Local 在真实结果位置展开引用，
    // 且只发送常驻 + 控制入口，不把 deferred 全量 schema 塞回去。
    let summary_request = h
        .bodies()
        .into_iter()
        .find(|body| body.to_string().contains("summarize"))
        .expect("compact summary request");
    let summary_text = summary_request.to_string();
    assert!(
        !summary_text.contains("\\\"tool_reference\\\""),
        "{summary_request:#?}"
    );
    assert!(summary_text.contains("<functions>"), "{summary_request:#?}");
    let names = tools(&summary_request);
    assert!(!names.iter().any(|(name, _)| name == "TodoWrite"));
    assert!(names.iter().any(|(name, _)| name == "ToolSearch"));
    assert!(names.iter().any(|(name, _)| name == "DeferredToolCall"));
    let before = h.bodies().len();
    h.send(4, &session, "continue").await;
    h.wait_requests(before + 1).await;
    let bodies = h.bodies();
    let after = bodies.last().unwrap();
    let conn = rusqlite::Connection::open(&h.db).unwrap();
    let parts: Vec<String> = conn
        .prepare("select data from part where session_id = ? and json_extract(data, '$.type') = 'compaction'")
        .unwrap()
        .query_map([&session], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    eprintln!("compaction parts: {parts:#?}");
    // compact 检查点把 TodoWrite 提升为普通工具；仍保留 Local 控制入口。
    let names = tools(after);
    assert!(
        names.contains(&("TodoWrite".to_owned(), false)),
        "{names:?}"
    );
    assert!(names.iter().any(|(name, _)| name == "ToolSearch"));
    assert!(names.iter().any(|(name, _)| name == "DeferredToolCall"));

    let (root, dir) = h.close().await;
    let mut reopened = harness::Harness::start_root(fixture.clone(), root, dir).await;
    reopened
        .request(
            5,
            "session/resume",
            json!({"sessionId": session, "runtimeConfig": {"toolSearch": {"mode": "local"}}}),
        )
        .await;
    let before = reopened.bodies().len();
    reopened.send(6, &session, "again").await;
    reopened.wait_requests(before + 1).await;
    let bodies = reopened.bodies();
    let names = tools(bodies.last().unwrap());
    assert!(
        names.contains(&("TodoWrite".to_owned(), false)),
        "{names:?}"
    );
    reopened.close().await;
}

#[tokio::test]
async fn off_projection_removes_controls_and_references_on_cold_resume() {
    let script = vec![
        tool_reply(
            "s1",
            "ToolSearch",
            json!({"query":"select:TodoWrite","max_results":5}),
        ),
        text_reply("Loaded."),
        text_reply("Off again."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "native").await;
    h.send(2, &session, "load todo").await;
    h.settled(&session, 1).await;
    let (root, dir) = h.close().await;

    let mut reopened = harness::Harness::start_root(fixture.clone(), root, dir).await;
    reopened
        .request(
            3,
            "session/resume",
            json!({"sessionId": session, "runtimeConfig": {"toolSearch": {"mode": "off"}}}),
        )
        .await;
    reopened.send(4, &session, "off").await;
    reopened.settled(&session, 2).await;
    let bodies = reopened.bodies();
    let last = bodies.last().unwrap();
    let names = tools(last);
    assert!(names.iter().any(|(name, _)| name == "TodoWrite"));
    assert!(!names.iter().any(|(name, _)| name == "ToolSearch"));
    assert!(!names.iter().any(|(name, _)| name == "DeferredToolCall"));
    let text = last.to_string();
    assert!(text.contains("[Tool references removed - tool search not enabled]"));
    assert!(!text.contains("\\\"tool_reference\\\""));
    // Off 在按 role 分流之前隐藏历史公告，模型不能读到失效的 ToolSearch 指引。
    assert!(!text.contains("The following deferred tools are now available via ToolSearch"));
    reopened.close().await;
}

#[tokio::test]
async fn tool_search_needs_no_approval_in_build_or_plan() {
    let script = vec![
        tool_reply(
            "s1",
            "ToolSearch",
            json!({"query":"select:TodoWrite","max_results":5}),
        ),
        text_reply("build done."),
        tool_reply(
            "s2",
            "ToolSearch",
            json!({"query":"select:TodoWrite","max_results":5}),
        ),
        text_reply("plan done."),
    ];
    let fixture = Arc::new(Fixture::start(script).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    for (index, execution) in ["build", "plan"].into_iter().enumerate() {
        let id = index as u64 * 10 + 1;
        let session = h.create_mode(id, execution, "local").await;
        h.send(id + 1, &session, "find todo").await;
        h.settled(&session, 1).await;
    }
    // 没有权限请求可应答的前提下仍完成两轮：搜索在 build/plan 都是只读放行。
    let bodies = h.bodies();
    assert_eq!(bodies.len(), 4, "{bodies:#?}");
    for pair in bodies.chunks(2) {
        let text = pair[1].to_string();
        // 搜索结果提交为真实引用，下一请求在 Local 投影中展开为目标 schema。
        assert!(
            text.contains("<functions>") && text.contains("TodoWrite"),
            "{:#?}",
            pair[1]
        );
    }
    h.close().await;
}

#[tokio::test]
async fn stop_cancels_a_hanging_model_request_before_any_discovery() {
    let fixture =
        Arc::new(Fixture::start(vec![fixture::hold(), text_reply("after cancel.")]).await);
    let mut h = harness::Harness::start(fixture.clone()).await;
    let session = h.create(1, "native").await;
    h.send(2, &session, "hang").await;
    h.wait_requests(1).await;
    h.stop(3, &session).await;
    // 取消后同一 runtime 必须能接受下一输入；若 stop 未生效会因 busy 被拒绝。
    for attempt in 0..50 {
        let reply = h.send(4, &session, "after").await;
        if reply.get("result").is_some() {
            break;
        }
        assert!(
            attempt < 49,
            "cancel did not release the session: {reply:#?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    h.wait_requests(2).await;
    let bodies = h.bodies();
    assert_eq!(bodies.len(), 2, "{bodies:#?}");
    // 取消的请求没有产生搜索/发现，下一请求仍只有常驻工具。
    assert!(
        !tools(&bodies[1])
            .iter()
            .any(|(name, _)| name == "TodoWrite")
    );
    h.close().await;
}
