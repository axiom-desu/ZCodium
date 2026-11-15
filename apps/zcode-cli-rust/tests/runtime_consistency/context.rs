// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! 3.18 F1/F2/F3 的真实 runtime 行为（`.agents/specs/upstream-3.18-rust-context.md`）：
//! 指令公告只发一次、余额提醒每步一条、主会话 system 字节快照落库。
use super::*;
use zcode_cli_rust::contract::ContextPort;
use zcode_cli_rust::domain::prompt::{InstructionRead, InstructionSource, PromptSnapshot};

struct StubContext {
    instructions: Vec<InstructionSource>,
    unreadable: Vec<String>,
}

#[async_trait]
impl ContextPort for StubContext {
    fn desktop(&self) -> bool {
        false
    }
    async fn snapshot(&self, _: &CancellationToken) -> Result<PromptSnapshot> {
        Ok(PromptSnapshot {
            cwd: "/w".into(),
            platform: "linux".into(),
            shell: "bash".into(),
            os_version: "linux 6".into(),
            current_date: "2026-01-01".into(),
            git: None,
        })
    }
    async fn instructions(&self, _: &CancellationToken) -> Result<InstructionRead> {
        Ok(InstructionRead {
            sources: self
                .instructions
                .iter()
                .map(|s| InstructionSource {
                    path: s.path.clone(),
                    user: s.user,
                    content: s.content.clone(),
                    truncated: s.truncated,
                    kind: s.kind.clone(),
                })
                .collect(),
            unreadable: self.unreadable.clone(),
        })
    }
}

fn source(path: &str, body: &str, user: bool) -> InstructionSource {
    InstructionSource {
        path: path.into(),
        user,
        content: body.into(),
        truncated: false,
        kind: None,
    }
}

/// 允许提交直到模型请求出现；返回请求消息与期间的会话快照。
async fn request_after_commits(runtime: &mut Runtime) -> (Vec<Value>, Vec<Session>) {
    let mut snapshots = vec![];
    loop {
        tokio::select! {
            Some(commit) = runtime.commits.recv() => {
                if let Some(session) = commit.session.clone() {
                    snapshots.push(session);
                }
                let _ = commit.permit.send(true);
            }
            Some(request) = runtime.requests.recv() => return (request, snapshots),
            else => panic!("runtime ended before the model request"),
        }
    }
}

fn notice<'a>(request: &'a [Value], source: &str) -> Vec<&'a Value> {
    request
        .iter()
        .filter(|message| message["_zcode_source"] == source)
        .collect()
}

#[tokio::test]
async fn instructions_are_announced_once_and_every_request_carries_the_budget() {
    let context = Arc::new(StubContext {
        unreadable: vec![],
        instructions: vec![
            source("/w/AGENTS.md", "workspace rules", false),
            source("/h/AGENTS.md", "private rules", true),
        ],
    });
    let mut runtime = start_with_context(
        vec![],
        None,
        json!({"text":"run"}),
        (60_000, 300_000),
        context,
        Some(ModelIdentity {
            provider_id: "p".into(),
            model_id: "m".into(),
            reasoning_level: "none".into(),
        }),
    )
    .await;
    let (request, snapshots) = request_after_commits(&mut runtime).await;

    // F1：首条请求带完整公告（preamble + 两个文件块），作为 provider 可见的提醒。
    let announcements = notice(&request, "context_prefix");
    assert_eq!(announcements.len(), 1);
    let body = announcements[0]["content"].as_str().unwrap();
    assert!(body.contains("Codebase and user instructions are shown below."));
    assert!(
        body.contains(
            "Contents of /w/AGENTS.md (project instructions, checked into the codebase):"
        )
    );
    assert!(body.contains(
        "Contents of /h/AGENTS.md (user's private global instructions for all projects):"
    ));
    assert!(body.contains("workspace rules") && body.contains("private rules"));

    // F2：system 末尾固定余额行 + 本步唯一的倒数提醒。
    let system: Vec<&Value> = request.iter().filter(|m| m["role"] == "system").collect();
    assert_eq!(system.len(), 3);
    assert!(system[0]["content"].as_str().is_some_and(|c| !c.is_empty()));
    let last_system = system[2]["content"].as_str().unwrap();
    assert!(last_system.ends_with("<total_tokens>15000000 tokens left</total_tokens>"));
    let budget = notice(&request, "total_tokens_reminder");
    assert_eq!(budget.len(), 1);
    assert!(
        budget[0]["content"]
            .as_str()
            .unwrap()
            .contains("<total_tokens>15000000 tokens left</total_tokens>")
    );

    // 其余提交（F3 的快照写入等）在本轮结束前全部处理完再断言。
    let mut snapshots = snapshots;
    while let Some(commit) = runtime.commits.recv().await {
        if let Some(session) = commit.session.clone() {
            snapshots.push(session);
        }
        let done = commit.phase == "completedSuccess";
        let _ = commit.permit.send(true);
        if done {
            break;
        }
    }
    // F3：system 字节快照已交给 owner（写入 session_entry，冷恢复据此复用）。
    assert!(
        snapshots.iter().any(
            |session| session.prompt_system.as_ref().is_some_and(|entry| {
                entry["system"]
                    .as_array()
                    .is_some_and(|system| system.len() == 3 && entry["model"]["providerId"] == "p")
            })
        ),
        "the frozen system messages must be recorded for cold resume"
    );

    // F4：走真实 stdio-value RPC → Engine 查询，composition 必须来自发出的请求而非 query 预演。
    let session_id = snapshots
        .iter()
        .find(|session| !session.id.is_empty())
        .map(|session| session.id.clone())
        .expect("the runtime committed a session");
    let query = serde_json::from_value(json!({
        "id": 2,
        "method": "v4/conversation/contextComposition",
        "params": {"sessionId": session_id}
    }))
    .unwrap();
    runtime.input.send(Input::Request(query)).await.unwrap();
    let reply = loop {
        let batch = tokio::time::timeout(std::time::Duration::from_secs(3), runtime.output.recv())
            .await
            .unwrap()
            .unwrap();
        if let Some(reply) = batch.into_iter().find(|value| value["id"] == 2) {
            break reply;
        }
    };
    assert_eq!(reply["result"]["composition"]["phase"], "request");
    assert_eq!(reply["result"]["composition"]["revision"], 1);
    assert!(
        reply["result"]["composition"]["categories"]
            .as_array()
            .is_some_and(|items| {
                items.iter().any(|item| item["id"] == "system_prompt")
                    && items.iter().any(|item| item["id"] == "messages")
            })
    );
    runtime.running.abort();
    let _ = runtime.running.await;
}

#[tokio::test]
async fn a_second_turn_does_not_resend_the_unchanged_announcement() {
    let context = Arc::new(StubContext {
        unreadable: vec![],
        instructions: vec![source("/w/AGENTS.md", "workspace rules", false)],
    });
    let mut runtime = start_with_context(
        vec![],
        None,
        json!({"text":"first"}),
        (60_000, 300_000),
        context,
        Some(ModelIdentity {
            provider_id: "p".into(),
            model_id: "m".into(),
            reasoning_level: "none".into(),
        }),
    )
    .await;
    let (first, _) = request_after_commits(&mut runtime).await;
    assert_eq!(notice(&first, "context_prefix").len(), 1);
    let id = {
        let mut session_id = String::new();
        while let Some(commit) = runtime.commits.recv().await {
            session_id = commit.session_id.clone();
            let done = commit.phase == "completedSuccess";
            let _ = commit.permit.send(true);
            if done {
                break;
            }
        }
        session_id
    };
    assert!(!id.is_empty(), "the session finished");

    let request = serde_json::from_value(json!({"id":2,"method":"v4/command","params":{
        "commandId":"second", "clientId":"test", "sessionId":id, "type":"sendText",
        "issuedAt":1000, "payload":{"text":"second"}
    }}))
    .unwrap();
    runtime.input.send(Input::Request(request)).await.unwrap();
    let (second, _) = request_after_commits(&mut runtime).await;
    // 历史里仍有一条完整公告，但没有追加新的（文件未变化）。
    assert_eq!(notice(&second, "context_prefix").len(), 1);
    // 上一步的倒数被替换，不累积。
    assert_eq!(notice(&second, "total_tokens_reminder").len(), 1);
    runtime.running.abort();
    let _ = runtime.running.await;
}
