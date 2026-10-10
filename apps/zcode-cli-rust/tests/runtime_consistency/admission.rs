// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::*;

#[tokio::test]
async fn guide_admission_and_consumption_are_durable_barriers() {
    for fail_at in ["admission", "consume", "none"] {
        let (mut runtime, id, tool) = busy_fixture().await;
        send_busy(&runtime, &id, "guide").await;
        let admission = receive(&mut runtime.commits).await;
        assert_eq!(admission.queue[0]["delivery"]["admitted"], "guide");
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        assert!(!tool.done.is_closed());
        admission.permit.send(fail_at != "admission").unwrap();
        if fail_at == "admission" {
            assert!(runtime.running.await.unwrap().is_err());
            assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
            continue;
        }
        tool.done.send(()).unwrap();
        let tool_commit = receive(&mut runtime.commits).await;
        assert_eq!(tool_commit.last_role, "tool");
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        tool_commit.permit.send(true).unwrap();
        let guide = receive(&mut runtime.commits).await;
        assert_eq!(guide.last_role, "user");
        assert!(
            guide.messages.last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("new input")
        );
        assert!(guide.queue.is_empty());
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        guide.permit.send(fail_at != "consume").unwrap();
        if fail_at == "consume" {
            assert!(runtime.running.await.unwrap().is_err());
            assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        } else {
            receive(&mut runtime.requests).await;
            let next = receive(&mut runtime.requests).await;
            assert_eq!(next[next.len() - 2]["role"], "tool");
            assert_eq!(next.last().unwrap()["role"], "user");
            finish_success(runtime).await;
        }
    }
}

#[tokio::test]
async fn start_now_waits_for_reservation_terminal_and_promotion_commits() {
    for fail_at in ["admission", "terminal", "promotion", "none"] {
        let (mut runtime, id, tool) = busy_fixture().await;
        send_busy(&runtime, &id, "startNow").await;
        let admission = receive(&mut runtime.commits).await;
        assert_eq!(admission.queue[0]["delivery"]["admitted"], "startNow");
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        assert!(!tool.done.is_closed());
        admission.permit.send(fail_at != "admission").unwrap();
        if fail_at == "admission" {
            assert!(runtime.running.await.unwrap().is_err());
            assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
            continue;
        }
        let terminal = receive(&mut runtime.commits).await;
        assert_eq!(terminal.phase, "completedInterrupted");
        assert!(tool.done.is_closed());
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        terminal.permit.send(fail_at != "terminal").unwrap();
        if fail_at == "terminal" {
            assert!(runtime.running.await.unwrap().is_err());
            assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
            continue;
        }
        let promotion = receive(&mut runtime.commits).await;
        assert_eq!(promotion.phase, "running");
        assert_eq!(promotion.last_role, "user");
        assert!(promotion.queue.is_empty());
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        promotion.permit.send(fail_at != "promotion").unwrap();
        if fail_at == "promotion" {
            assert!(runtime.running.await.unwrap().is_err());
            assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        } else {
            receive(&mut runtime.requests).await;
            let next = receive(&mut runtime.requests).await;
            assert!(
                next.last().unwrap()["content"]
                    .as_str()
                    .unwrap()
                    .contains("new input")
            );
            assert_eq!(next[next.len() - 2]["role"], "tool");
            finish_success(runtime).await;
        }
    }
}

#[tokio::test]
async fn stop_during_start_now_reservation_holds_input_and_rejects_competing_promotion() {
    let (mut runtime, id, tool) = busy_fixture_with("SlowCancel").await;
    send_busy(&runtime, &id, "startNow").await;
    receive(&mut runtime.commits)
        .await
        .permit
        .send(true)
        .unwrap();
    // 消费 create 与 sendText 的 ACK；旧工具仍在清理，预留必须保持唯一。
    runtime.output.recv().await.unwrap();
    runtime.output.recv().await.unwrap();
    let command = |name: &str, kind: &str, payload: Value| {
        Input::Request(serde_json::from_value(json!({"id":name,"method":"v4/command","params":{
            "commandId":name,"clientId":"test","sessionId":id,"type":kind,"payload":payload,"issuedAt":1000
        }})).unwrap())
    };
    runtime
        .input
        .send(command(
            "other",
            "sendText",
            json!({"text":"competing", "requestedDelivery":"startNow"}),
        ))
        .await
        .unwrap();
    // 输出中夹有遥测通知（spec rust-m9-usage-logs §5）：按请求 id 取竞争命令的回复。
    let rejection = loop {
        let batch = runtime.output.recv().await.unwrap();
        if let Some(reply) = batch.into_iter().find(|m| m["id"] == "other") {
            break reply;
        }
    };
    assert_eq!(
        rejection["result"]["reasonCode"],
        "guard.queuePromotionBusy"
    );
    runtime
        .input
        .send(command("stop", "stop", json!({})))
        .await
        .unwrap();
    let stop = receive(&mut runtime.commits).await;
    assert_eq!(stop.queue[0]["delivery"]["admitted"], "queue");
    assert_eq!(stop.queue[0]["dispatch"]["state"], "queued");
    stop.permit.send(true).unwrap();
    tool.done.send(()).unwrap();
    let terminal = receive(&mut runtime.commits).await;
    assert_eq!(terminal.phase, "completedInterrupted");
    assert_eq!(terminal.queue.len(), 1);
    terminal.permit.send(true).unwrap();
    runtime.input.send(Input::Eof).await.unwrap();
    runtime.running.await.unwrap().unwrap();
    assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn eof_cannot_promote_an_accepted_start_now_reservation() {
    let (mut runtime, id, tool) = busy_fixture_with("SlowCancel").await;
    send_busy(&runtime, &id, "startNow").await;
    receive(&mut runtime.commits)
        .await
        .permit
        .send(true)
        .unwrap();
    runtime.output.recv().await.unwrap();
    runtime.output.recv().await.unwrap();
    runtime.input.send(Input::Eof).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while runtime.tools.cancellations.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tool.done.send(()).unwrap();
    let terminal = receive(&mut runtime.commits).await;
    assert_eq!(terminal.phase, "completedInterrupted");
    terminal.permit.send(true).unwrap();
    runtime.running.await.unwrap().unwrap();
    assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
    assert!(runtime.commits.try_recv().is_err());
}

#[tokio::test]
async fn unconfirmed_process_cleanup_stops_runtime_before_any_next_model_request() {
    let mut runtime = start(vec![call(0, "CleanupFailure")], None).await;
    let mut commits = runtime.commits;
    let database = tokio::spawn(async move {
        while let Some(commit) = commits.recv().await {
            let _ = commit.permit.send(true);
        }
    });
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), runtime.running)
        .await
        .unwrap()
        .unwrap();
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("fault.runtime.processCleanup")
    );
    assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 1);
    receive(&mut runtime.requests).await;
    assert!(runtime.requests.try_recv().is_err());
    drop(runtime.store);
    database.await.unwrap();
}

#[tokio::test]
async fn todo_state_and_result_commits_gate_next_tools_and_recover_actual_result() {
    for stage in ["state", "result", "recover"] {
        let todo_call = json!({"id":"todo-call","function":{"name":"TodoWrite","arguments":json!({"todos":[{"content":"durable todo","status":"in_progress","priority":"high"}]}).to_string()}});
        let mut runtime = start(vec![todo_call, call(2, "Write")], None).await;
        let state = loop {
            let c = receive(&mut runtime.commits).await;
            if c.session.as_ref().is_some_and(|s| !s.todos.is_empty()) {
                break c;
            }
            c.permit.send(true).unwrap();
        };
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 0);
        assert_eq!(state.last_role, "assistant");
        let saved = state.session.unwrap();
        assert_eq!(saved.todos.len(), 1);
        assert_eq!(saved.todos[0].content, "durable todo");
        state.permit.send(stage != "state").unwrap();
        if stage == "recover" {
            runtime.running.abort();
            let _ = runtime.running.await;
            let mut recovered = saved;
            recovered.recover("cold".into(), 2000);
            let result = recovered
                .messages
                .iter()
                .find(|m| m["tool_call_id"] == "todo-call")
                .unwrap();
            let data: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
            assert_eq!(data["todos"][0]["content"], "durable todo");
            assert_eq!(recovered.todos.len(), 1);
            continue;
        }
        if stage == "result" {
            let c = receive(&mut runtime.commits).await;
            assert_eq!(c.last_role, "tool");
            assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 0);
            c.permit.send(false).unwrap();
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), runtime.running)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 0);
        assert!(runtime.commits.try_recv().is_err());
    }
}
