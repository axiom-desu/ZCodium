// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! An engine over a real `NodeStore` with a scripted model: every turn is a
//! `Read` tool step with reasoning, then the answer.
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zcode_cli_rust::contract::*;

/// Ids and times from `offset`, so a restarted runtime never reuses them;
/// time also advances with the wall clock (question deadlines are timers).
pub(super) struct Clock(pub(super) AtomicUsize, pub(super) std::time::Instant);
impl RuntimeClock for Clock {
    fn id(&self) -> String {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        format!("00000000-0000-4000-8000-{n:012}")
    }
    fn now(&self) -> u64 {
        let elapsed = self.1.elapsed().as_millis() as u64;
        1_790_000_000_000 + self.0.load(Ordering::SeqCst) as u64 + elapsed
    }
}

pub(super) struct Model {
    pub(super) calls: AtomicUsize,
    pub(super) verifications: AtomicUsize,
    pub(super) requests: mpsc::UnboundedSender<Vec<Value>>,
}
#[async_trait]
impl ModelPort for Model {
    fn format_properties(&self) -> Value {
        json!({"inputFormat": {"supportsText": true, "supportsImage": true, "supportsVideo": true,
            "supportsAudio": false, "supportsPdf": true}, "outputFormat": {"supportsText": true}})
    }
    async fn complete(
        &self,
        messages: Vec<Value>,
        _: &[Value],
        sink: &EventSink,
        _: &CancellationToken,
    ) -> std::result::Result<ModelOutput, ModelFailure> {
        // 目标完成验证：第一次未通过（带下一步），之后通过。
        let verify = messages.last().is_some_and(|m| {
            m["content"].as_str().is_some_and(|c| {
                c.starts_with("Verify whether the active session goal is actually complete.")
            })
        });
        if verify {
            let n = self.verifications.fetch_add(1, Ordering::SeqCst);
            let stall = messages
                .last()
                .is_some_and(|m| m["content"].as_str().is_some_and(|c| c.contains("stall")));
            let verdict = if n == 0 && stall {
                json!({"passed": false, "reason": "Blocked."})
            } else if n == 0 {
                json!({"passed": false, "reason": "No tests yet.", "nextAction": "Write the tests."})
            } else {
                json!({"passed": true, "reason": "Tests pass.", "nextAction": ""})
            };
            return Ok(ModelOutput {
                output_limit: false,
                message: json!({"role": "assistant", "content": verdict.to_string()}),
                calls: vec![],
                usage: json!({"prompt_tokens": 20, "completion_tokens": 5}),
                raw_finish_reason: None,
            });
        }
        let compaction = messages.last().is_some_and(|m| {
            m["content"]
                .as_str()
                .is_some_and(|c| c.starts_with("CRITICAL: Respond with TEXT ONLY"))
        });
        // 父会话首轮派生子代理：最后一条是“spawn a child”的用户输入时调用 Agent 工具。
        let spawn = messages.last().and_then(|m| {
            (m["role"] == "user")
                .then(|| m["content"].as_str())
                .flatten()
                .filter(|c| c.starts_with("spawn a"))
                .map(|c| c.contains("background"))
        });
        // 用户要求读图时 Read 读取图片，工具结果带媒体（Node tool result media）。
        let image = messages
            .iter()
            .rev()
            .find(|m| m["role"] == "user" && m.get("_zcode_source").is_none())
            .and_then(|m| m["content"].as_str())
            .is_some_and(|c| c.contains("read the image"));
        let file = if image { "shot.png" } else { "a.ts" };
        // 用户要求写入时调用 Write（build 模式下弹出权限询问）。
        let write = messages
            .iter()
            .rev()
            .find(|m| m["role"] == "user" && m.get("_zcode_source").is_none())
            .and_then(|m| m["content"].as_str())
            .is_some_and(|c| c.contains("write it"));
        let ask = messages
            .iter()
            .rev()
            .find(|m| m["role"] == "user" && m.get("_zcode_source").is_none())
            .and_then(|m| m["content"].as_str())
            .is_some_and(|c| c.contains("ask me"));
        self.requests.send(messages).unwrap();
        if let Some(background) = spawn {
            let args = json!({"description": "Look around", "prompt": "Inspect a.ts",
                "subagent_type": "general-purpose", "run_in_background": background});
            let call = json!({"id": "call_agent", "type": "function", "function": {"name": "Agent",
                "arguments": args.to_string()}});
            sink.send(Event::ModelStatus(
                json!({"type": "model_request_started", "querySource": "main_turn",
                "attempt": 1, "requestId": "spawn", "providerId": "p", "modelId": "m"}),
            ))
            .await
            .unwrap();
            sink.send(Event::ModelStatus(json!({"type": "model_request_completed", "querySource": "main_turn",
                "attempt": 1, "requestId": "spawn", "providerId": "p", "modelId": "m", "finishReason": "tool-calls"})))
                .await
                .unwrap();
            return Ok(ModelOutput {
                output_limit: false,
                message: json!({"role": "assistant", "content": "", "tool_calls": [call.clone()],
                    "_zcode_origin": {"provider": "p", "model": "m"}}),
                calls: vec![call],
                usage: json!({}),
                raw_finish_reason: None,
            });
        }
        if compaction {
            // 压缩摘要请求：只返回摘要，不计入对话步骤。
            return Ok(ModelOutput {
                output_limit: false,
                message: json!({"role": "assistant",
                    "content": "<analysis>ok</analysis><summary>Fixed the parser.</summary>"}),
                calls: vec![],
                usage: json!({"prompt_tokens": 50, "completion_tokens": 10}),
                raw_finish_reason: None,
            });
        }
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let tool_step = n.is_multiple_of(2);
        let status = |kind: &str, extra: Value| {
            let mut status = json!({"type": kind, "querySource": "main_turn", "attempt": 1,
                "requestId": format!("req{n}"), "providerId": "p", "modelId": "m"});
            for (key, value) in extra.as_object().unwrap() {
                status[key] = value.clone();
            }
            Event::ModelStatus(status)
        };
        sink.send(status("model_request_started", json!({})))
            .await
            .unwrap();
        let text = if tool_step { "Let me read." } else { "Done." };
        let mut pieces = vec![(text, false)];
        if tool_step {
            pieces.insert(0, ("Look", true));
        }
        for (piece, reasoning) in pieces {
            sink.send(Event::Text {
                response_id: format!("r{n}"),
                text: piece.into(),
                reasoning,
            })
            .await
            .unwrap();
        }
        let finish = if tool_step { "tool-calls" } else { "stop" };
        let usage = json!({"inputTokens": 100, "outputTokens": 5, "totalTokens": 105});
        sink.send(status(
            "model_request_completed",
            json!({"finishReason": finish, "usage": usage}),
        ))
        .await
        .unwrap();
        // 与 HttpModel 一致：返回的 assistant 带来源模型。
        let mut message = json!({"role": "assistant", "content": text,
            "_zcode_origin": {"provider": "p", "model": "m"}});
        let mut calls = vec![];
        if tool_step {
            message["reasoning_content"] = "Look".into();
            calls = vec![json!({"id": format!("call_{n}"), "type": "function",
            "function": if ask {
                let questions = json!({"questions": [{"question": "Which one?", "header": "Pick",
                    "multiSelect": false, "options": [{"label": "A", "description": "a"},
                    {"label": "B", "description": "b"}]}]});
                json!({"name": "AskUserQuestion", "arguments": questions.to_string()})
            } else if write {
                json!({"name": "Write", "arguments": json!({"file_path": "b.ts", "content": "x"}).to_string()})
            } else {
                json!({"name": "Read", "arguments": json!({"file_path": file}).to_string()})
            }})];
            message["tool_calls"] = json!(calls);
        }
        Ok(ModelOutput {
            output_limit: false,
            message,
            calls,
            usage: json!({"prompt_tokens": 100, "completion_tokens": 5}),
            raw_finish_reason: None,
        })
    }
}

/// The image `Read` returns for `shot.png`.
/// A valid 1x1 PNG: prompt images are decoded like Node's Jimp (a broken
/// image becomes a placeholder).
pub(super) const IMAGE: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0,
    0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 248, 95, 15, 0, 2, 128, 1,
    127, 12, 105, 242, 97, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
