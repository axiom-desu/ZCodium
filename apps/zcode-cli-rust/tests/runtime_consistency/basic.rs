// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::*;

#[tokio::test]
async fn question_registration_answer_timer_and_result_are_durable_barriers() {
    let question = json!({"id":"question-call","function":{"name":"AskUserQuestion","arguments":json!({"questions":[{"question":"Which?","header":"Choice","options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]}]}).to_string()}});
    for stage in [
        "registration",
        "answer",
        "snooze",
        "automatic",
        "result",
        "recover",
    ] {
        let timing = if stage == "automatic" {
            (0, 0)
        } else {
            (60_000, 300_000)
        };
        let mut runtime =
            start_timed(vec![question.clone()], None, json!({"text":"run"}), timing).await;
        let pending = loop {
            let c = receive(&mut runtime.commits).await;
            if c.permission.is_some() {
                break c;
            }
            c.permit.send(true).unwrap();
        };
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        let id = pending.session_id.clone();
        let interaction = pending.permission.as_ref().unwrap()["interactionId"].clone();
        pending.permit.send(stage != "registration").unwrap();
        if stage != "registration" {
            if stage != "automatic" {
                let request=serde_json::from_value(json!({"id":2,"method":"v4/command","params":{
                    "commandId":"answer","clientId":"test","sessionId":id,"issuedAt":1000,
                    "type":if stage=="snooze"{"snoozeInteractionAutoResolution"}else{"resolveInteraction"},
                    "payload":{"interactionId":interaction,"answer":{"action":"accept","content":{"answers":{"Which?":"A"}}}}
                }})).unwrap();
                runtime.input.send(Input::Request(request)).await.unwrap();
            }
            let c = receive(&mut runtime.commits).await;
            assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
            assert_eq!(c.last_role, "assistant");
            if stage == "recover" {
                let mut recovered = c.session.unwrap();
                c.permit.send(true).unwrap();
                // 模拟答案事务刚提交时崩溃：磁盘上没有 canonical tool，但答案必须可恢复。
                runtime.running.abort();
                let _ = runtime.running.await;
                recovered.recover("new-epoch".into(), 2000);
                assert!(recovered.pending.is_empty());
                assert_eq!(
                    recovered.phase,
                    zcode_cli_rust::domain::execution::Phase::CompletedInterrupted
                );
                assert_eq!(
                    recovered.messages.last().unwrap()["tool_call_id"],
                    "question-call"
                );
                assert!(
                    recovered.messages.last().unwrap()["content"]
                        .as_str()
                        .unwrap()
                        .contains("\"Which?\"=\"A\"")
                );
                continue;
            }
            c.permit.send(stage == "result").unwrap();
            if stage == "result" {
                let c = receive(&mut runtime.commits).await;
                assert_eq!(c.last_role, "tool");
                assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
                c.permit.send(false).unwrap();
            }
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), runtime.running)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err(), "stage {stage}");
        assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 0);
        assert!(
            runtime.commits.try_recv().is_err(),
            "failed question transaction was resurrected"
        );
    }
}

#[tokio::test]
async fn attachment_input_cannot_execute_before_its_session_commit() {
    let mut runtime = start_with_input(vec![], None, json!({"text":"", "attachments":[{"ref":"local.txt","fileName":"local.txt","mime":"text/plain","bytes":4}]})).await;
    let commit = receive(&mut runtime.commits).await;
    assert_eq!(commit.last_role, "user");
    assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 0);
    assert!(runtime.requests.try_recv().is_err());
    commit.permit.send(false).unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(3), runtime.running)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn commit_failures_do_not_execute_or_resurrect_uncommitted_facts() {
    for fail_at in [1, 2, 3, 5] {
        let mut runtime = start(vec![call(0, "Read")], None).await;
        for ordinal in 1..=fail_at {
            let commit = receive(&mut runtime.commits).await;
            if ordinal <= 2 {
                assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 0);
            }
            if ordinal == 3 {
                assert_eq!(commit.last_role, "assistant");
                tokio::task::yield_now().await;
                assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 0);
            }
            if ordinal == 5 {
                assert_eq!(commit.last_role, "tool");
                tokio::task::yield_now().await;
                assert_eq!(runtime.model.calls.load(Ordering::SeqCst), 1);
            }
            commit.permit.send(ordinal != fail_at).unwrap();
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), runtime.running)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        assert_eq!(runtime.store.calls.load(Ordering::SeqCst), fail_at);
        assert_eq!(
            runtime.tools.calls.load(Ordering::SeqCst),
            usize::from(fail_at == 5)
        );
    }
}

#[tokio::test]
async fn four_readers_preserve_result_order_and_write_barrier() {
    let (tx, mut started) = mpsc::unbounded_channel();
    let calls = (0..8)
        .map(|n| call(n, if n == 6 { "Write" } else { "Read" }))
        .collect();
    let mut runtime = start(calls, Some(tx)).await;
    let (complete, finished) = oneshot::channel();
    let mut commits = runtime.commits;
    let database = tokio::spawn(async move {
        while let Some(commit) = commits.recv().await {
            let done = commit.phase == "completedSuccess";
            commit.permit.send(true).unwrap();
            if done {
                let _ = complete.send(());
                break;
            }
        }
    });
    let mut first = vec![];
    for n in 0..4 {
        let tool = receive(&mut started).await;
        assert_eq!(tool.n, n);
        first.push(tool);
    }
    assert!(started.try_recv().is_err());
    // 后面的 Read 先完成，首个仍在等待；不能越过写屏障或改变 canonical 结果顺序。
    for tool in first.drain(1..).rev() {
        tool.done.send(()).unwrap();
    }
    tokio::task::yield_now().await;
    assert!(started.try_recv().is_err());
    first.remove(0).done.send(()).unwrap();
    let a = receive(&mut started).await;
    let b = receive(&mut started).await;
    assert_eq!((a.n, b.n), (4, 5));
    b.done.send(()).unwrap();
    a.done.send(()).unwrap();
    let write = receive(&mut started).await;
    assert_eq!((write.n, write.name.as_str()), (6, "Write"));
    assert!(started.try_recv().is_err());
    write.done.send(()).unwrap();
    let last = receive(&mut started).await;
    assert_eq!(last.n, 7);
    last.done.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), finished)
        .await
        .unwrap()
        .unwrap();
    receive(&mut runtime.requests).await;
    let request = receive(&mut runtime.requests).await;
    let results = request
        .iter()
        .filter(|m| m["role"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 8);
    for (n, result) in results.iter().enumerate() {
        assert_eq!(result["tool_call_id"], format!("call{n}"));
    }
    assert!(
        results[1]["content"]
            .as_str()
            .unwrap()
            .contains("injected tool failure")
    );
    let mut batch = runtime.output.recv().await.unwrap();
    let session = batch.remove(0)["result"]["result"]["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let request=serde_json::from_value(json!({"id":2,"method":"v4/conversation/rowsRange","params":{"sessionId":session,"limit":200}})).unwrap();
    runtime.input.send(Input::Request(request)).await.unwrap();
    let rows = runtime.output.recv().await.unwrap();
    assert!(!rows[0].to_string().contains("stale pollution"));
    runtime.input.send(Input::Eof).await.unwrap();
    runtime.running.await.unwrap().unwrap();
    database.await.unwrap();
}

#[tokio::test]
async fn permission_resolution_is_one_durable_commit_before_effects() {
    for allow_commit in [false, true] {
        let mut runtime = start(vec![call(0, "GuardedWrite")], None).await;
        for _ in 0..4 {
            receive(&mut runtime.commits)
                .await
                .permit
                .send(true)
                .unwrap();
        }
        let pending = receive(&mut runtime.commits).await;
        let interaction = pending.permission.as_ref().unwrap()["interactionId"].clone();
        pending.permit.send(true).unwrap();
        let request=serde_json::from_value(json!({"id":2,"method":"v4/command","params":{
            "commandId":"approve","clientId":"test","sessionId":pending.session_id,"type":"resolveInteraction","issuedAt":1000,
            "payload":{"interactionId":interaction,"answer":{"optionId":"allowOnce"}}
        }})).unwrap();
        runtime.input.send(Input::Request(request)).await.unwrap();
        let resolving = receive(&mut runtime.commits).await;
        assert!(resolving.permission.is_none());
        assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 0);
        resolving.permit.send(allow_commit).unwrap();
        if allow_commit {
            let result = receive(&mut runtime.commits).await;
            assert_eq!(result.last_role, "tool"); // No second permission write between approval and result.
            assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 1);
            result.permit.send(true).unwrap();
            loop {
                let commit = receive(&mut runtime.commits).await;
                let done = commit.phase == "completedSuccess";
                commit.permit.send(true).unwrap();
                if done {
                    break;
                }
            }
            runtime.input.send(Input::Eof).await.unwrap();
            runtime.running.await.unwrap().unwrap();
        } else {
            assert!(runtime.running.await.unwrap().is_err());
            assert_eq!(runtime.store.calls.load(Ordering::SeqCst), 6);
            assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 0);
        }
    }
}

#[tokio::test]
async fn unsaved_always_allow_rule_fails_the_call_like_node() {
    // 测试 Store 没有项目设置存储：写规则失败时，交互仍按允许解决，但工具不执行，
    // 模型收到 Node permission-flow 的存储错误。
    let mut runtime = start(vec![call(0, "GuardedWrite")], None).await;
    for _ in 0..4 {
        receive(&mut runtime.commits)
            .await
            .permit
            .send(true)
            .unwrap();
    }
    let pending = receive(&mut runtime.commits).await;
    let interaction = pending.permission.as_ref().unwrap()["interactionId"].clone();
    pending.permit.send(true).unwrap();
    let request=serde_json::from_value(json!({"id":2,"method":"v4/command","params":{
        "commandId":"approve","clientId":"test","sessionId":pending.session_id,"type":"resolveInteraction","issuedAt":1000,
        "payload":{"interactionId":interaction,"answer":{"optionId":"allowAlways"}}
    }})).unwrap();
    runtime.input.send(Input::Request(request)).await.unwrap();
    receive(&mut runtime.commits)
        .await
        .permit
        .send(true)
        .unwrap();
    let result = receive(&mut runtime.commits).await;
    let message = result.messages.last().unwrap();
    assert_eq!(message["role"], "tool");
    assert_eq!(
        message["content"],
        "Failed to persist project permission update"
    );
    assert_eq!(message["_zcode_tool_failed"], true);
    assert_eq!(runtime.tools.calls.load(Ordering::SeqCst), 0);
    result.permit.send(true).unwrap();
    loop {
        let commit = receive(&mut runtime.commits).await;
        let done = commit.phase == "completedSuccess";
        commit.permit.send(true).unwrap();
        if done {
            break;
        }
    }
    runtime.input.send(Input::Eof).await.unwrap();
    runtime.running.await.unwrap().unwrap();
}
