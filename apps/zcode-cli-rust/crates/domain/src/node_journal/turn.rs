//! Turn and model-step journal hooks (Node `persistUserPrompt`,
//! `runModelBackedTurnStep`, `executeToolCallsForModelStep`, `turn-stop.ts`,
//! `persistCancelledStreamSnapshot`, `recoverPartialAssistantOutputFailure`).
use super::records::{self as r, Assistant, UserPrompt};
use super::{Op, Step, Tool, Turn};
use crate::session::Session;
use serde_json::{Value, json};

/// What an admitted input records in the `session_input` ledger (Node V4
/// `admitInputCommand`).
pub struct Admission<'a> {
    pub queue_id: &'a str,
    pub kind: &'a str,
    /// `payload`: `{text, intent, conversationInputIntent, attachments, sourceCommandType}`.
    pub payload: Value,
    pub delivery: &'a str,
}

/// The user prompt of a started turn.
pub struct Prompt<'a> {
    pub message: String,
    pub part: String,
    /// The run's turn uuid (`anchor.turnId = turn_<uuid>`).
    pub turn: &'a str,
    pub text: &'a str,
    pub command: Option<&'a str>,
    pub queue_id: Option<&'a str>,
    /// Node `metadata`: `{inputIntent, conversationInputIntent, inputClientId, ...}`.
    pub metadata: Option<Value>,
    pub tools: &'a [String],
    /// The attachments' `file` parts (with ids), after the text part.
    pub files: Vec<Value>,
}

impl Session {
    /// Node V4 admission: the ledger row, before the command is acknowledged.
    pub fn node_admit_input(&mut self, now: u64, a: Admission) {
        let row = json!({"id": a.queue_id, "sessionID": self.id, "kind": a.kind,
            "delivery": a.delivery, "payload": a.payload});
        self.node.push(now, Op::SaveInput(row));
    }

    /// Node `persistUserPrompt`: the user message with its text part, promoted
    /// from the ledger when the input was admitted there. Opens the turn.
    pub fn node_user_prompt(&mut self, now: u64, p: Prompt) {
        self.node_flush_model_change(now);
        let runtime = crate::node_ids::turn_id(p.turn);
        let user = p.message.clone();
        self.push_prompt(now, p, &runtime);
        self.open_turn(runtime, user);
    }

    /// The user message and its text part of `p` in the turn `runtime`.
    pub(super) fn push_prompt(&mut self, now: u64, p: Prompt, runtime: &str) {
        self.node.latest = Some(p.message.clone());
        let agent = self.node_agent();
        let context = self
            .prompt_snapshot
            .as_ref()
            .map(crate::prompt_env::context_snapshot);
        let message = r::user_message(&UserPrompt {
            id: &p.message,
            agent: &agent,
            session: &self.id,
            created: now,
            selection: self.node_selection(),
            context,
            turn: runtime,
            command: p.command,
            tools: p.tools,
            metadata: p.metadata,
        });
        if self.prompt_snapshot.is_none() {
            self.node.unsnapshotted.push(message.clone());
        }
        let mut parts = vec![r::text_part(p.part, &self.id, &p.message, p.text, now, now)];
        parts.extend(p.files);
        match p.queue_id {
            Some(id) => self.node.push(
                now,
                Op::PromoteInput {
                    id: id.into(),
                    message,
                    parts,
                },
            ),
            None => {
                self.node.push(now, Op::Message(message));
                for part in parts {
                    self.node.push(now, Op::Part(part));
                }
            }
        }
    }

    /// Node persists `contextSnapshot` with every prompt because its context is
    /// initialized before the prompt is written; Rust takes the first snapshot
    /// inside the run, so the prompts written before it are saved again with it.
    pub fn node_prompt_snapshot(&mut self, now: u64) {
        let Some(snapshot) = &self.prompt_snapshot else {
            return;
        };
        let context = crate::prompt_env::context_snapshot(snapshot);
        for message in std::mem::take(&mut self.node.unsnapshotted) {
            let mut out = serde_json::Map::new();
            for (key, value) in message.as_object().into_iter().flatten() {
                if key == "semantics" {
                    out.insert("contextSnapshot".into(), context.clone());
                }
                out.insert(key.clone(), value.clone());
            }
            self.node.push(now, Op::Message(Value::Object(out)));
        }
    }

    fn open_turn(&mut self, runtime: String, user: String) {
        self.node.turn = Some(Turn {
            runtime,
            messages: vec![user.clone()],
            user,
            ..Turn::default()
        });
    }

    /// Node `persistAssistantMessage`; `end` is `(completed, error, tokens,
    /// finish)` of a completing update.
    pub(super) fn assistant_record(
        &self,
        step: &Step,
        end: Option<(u64, Option<Value>, Value, Option<Value>)>,
    ) -> Value {
        let turn = self.node.turn.as_ref().expect("a step belongs to a turn");
        let directory = self.node_directory();
        let (completed, error, tokens, finish) = match end {
            Some((at, error, tokens, finish)) => (Some(at), error, Some(tokens), finish),
            None => (None, None, None, None),
        };
        r::assistant_message(&Assistant {
            id: &step.assistant,
            agent: &self.node_agent(),
            session: &self.id,
            parent: &turn.user,
            created: step.created,
            completed,
            error,
            provider: &step.provider,
            model: &step.model,
            mode: self.mode.as_str(),
            plan: self.plan_enabled,
            cwd: directory,
            root: directory,
            tokens,
            finish,
            turn: &turn.runtime,
        })
    }

    /// Node step start: the assistant message (not completed) and `step-start`.
    pub fn node_step_started(
        &mut self,
        now: u64,
        ids: (String, String),
        provider: &str,
        model: &str,
    ) {
        let Some(turn) = self.node.turn.as_mut() else {
            return;
        };
        let step = Step {
            assistant: ids.0,
            created: now,
            provider: provider.into(),
            model: model.into(),
            ..Step::default()
        };
        turn.messages.push(step.assistant.clone());
        self.node.latest = Some(step.assistant.clone());
        let message = self.assistant_record(&step, None);
        let part = r::step_start_part(ids.1, &self.id, &step.assistant);
        self.node.push(now, Op::Message(message));
        self.node.push(now, Op::Part(part));
        self.node.turn.as_mut().unwrap().step = Some(step);
    }

    /// `model_request_completed`: the step's finish reason and usage.
    pub fn node_model_status(&mut self, status: &Value) {
        if status["type"] != "model_request_completed" {
            return;
        }
        if let Some(step) = self.node.turn.as_mut().and_then(|t| t.step.as_mut()) {
            step.finish = status.get("finishReason").cloned();
            step.usage = status.get("usage").cloned();
        }
    }

    /// A model step is open (its assistant is not completed yet).
    pub fn node_step_open(&self) -> bool {
        self.open_step().is_some()
    }

    pub(super) fn open_step(&self) -> Option<Step> {
        self.node
            .turn
            .as_ref()
            .and_then(|t| t.step.clone())
            .filter(|s| !s.completed)
    }

    /// Completes the open step: `step-finish` and the finished assistant, or
    /// only the assistant with `error` (Node's failure paths write no finish).
    pub(super) fn complete_step(&mut self, now: u64, part: String, error: Option<Value>) {
        let Some(mut step) = self.open_step() else {
            return;
        };
        let end = match error {
            None => {
                let tokens = r::tokens(step.usage.as_ref());
                let finish = step.finish.clone().unwrap_or(Value::Null);
                let part =
                    r::step_finish_part(part, &self.id, &step.assistant, &finish, tokens.clone());
                self.node.push(now, Op::Part(part));
                (now, None, tokens, step.finish.clone())
            }
            Some(error) => (now, Some(error), r::tokens(None), None),
        };
        let message = self.assistant_record(&step, Some(end));
        self.node.push(now, Op::Message(message));
        step.completed = true;
        self.node.turn.as_mut().unwrap().step = Some(step);
    }

    /// Node ModelDone persistence: reasoning and text parts, then either the
    /// pending tool parts or the step's completion. `ids` yields fresh uuids.
    pub fn node_model_done(
        &mut self,
        now: u64,
        message: Option<&Value>,
        ids: &mut dyn FnMut() -> String,
    ) {
        let Some(mut step) = self.open_step() else {
            return;
        };
        let assistant = step.assistant.clone();
        let calls: Vec<Value> = message
            .and_then(|m| m["tool_calls"].as_array().cloned())
            .unwrap_or_default();
        // 3.18 R2：provider 原生工具按「服务端轮次」落库：每轮推理/正文 part 之后紧跟
        // 带 `providerExecuted` 的 tool part，冷恢复据此切回同一份段列表。
        let rounds: Vec<Value> = message
            .map(|m| crate::provider_rounds::segments(m).to_vec())
            .unwrap_or_default();
        if let Some(message) = message.filter(|_| rounds.is_empty()) {
            for (text, metadata) in super::reasoning_parts(message) {
                let id = super::part_id(now, &ids());
                let part = r::reasoning_part(
                    id,
                    &self.id,
                    &assistant,
                    &text,
                    metadata,
                    (step.created, now),
                );
                self.node.push(now, Op::Part(part));
            }
            if let Some(text) = message["content"].as_str().filter(|t| !t.is_empty()) {
                let part = r::text_part(
                    super::part_id(now, &ids()),
                    &self.id,
                    &assistant,
                    text,
                    step.created,
                    now,
                );
                self.node.push(now, Op::Part(part));
            }
        }
        for (index, round) in rounds.iter().enumerate() {
            let thinking = json!({"_zcode_anthropic_thinking": round["thinking"]});
            for (text, metadata) in super::reasoning_parts(&thinking) {
                let part = r::reasoning_part(
                    super::part_id(now, &ids()),
                    &self.id,
                    &assistant,
                    &text,
                    metadata,
                    (step.created, now),
                );
                self.node.push(now, Op::Part(part));
            }
            if let Some(text) = round["text"].as_str().filter(|t| !t.is_empty()) {
                let part = r::text_part(
                    super::part_id(now, &ids()),
                    &self.id,
                    &assistant,
                    text,
                    step.created,
                    now,
                );
                self.node.push(now, Op::Part(part));
            }
            let (call, result) = (&round["call"], &round["result"]);
            if !call.is_object() || !result.is_object() {
                continue;
            }
            let call_id = call["id"].as_str().unwrap_or("").to_owned();
            let name = call["name"].as_str().unwrap_or("").to_owned();
            let input = if call["input"].is_object() {
                call["input"].clone()
            } else {
                json!({})
            };
            let output = crate::provider_rounds::result_text(result);
            let failed = result["is_error"] == true;
            let window = (step.created, now);
            let state = if failed {
                r::error_tool(&input, &Value::from(output), None, window)
            } else {
                r::completed_tool(&name, &input, &Value::from(output), None, None, window)
            };
            let metadata = json!({
                crate::provider_rounds::EXECUTED_KEY: true,
                "schemaVersion": 1,
                crate::provider_rounds::CALL_BLOCK_KEY: call,
                crate::provider_rounds::RESULT_BLOCK_KEY: result,
            });
            let part = r::tool_part(
                &super::part_id(now, &ids()),
                &self.id,
                &assistant,
                (&call_id, index, &name),
                Some(metadata),
                state,
            );
            self.node.push(now, Op::Part(part));
        }
        let turn = self.node.turn.as_mut().unwrap();
        if message.is_some() {
            turn.rounds += 1;
        }
        if calls.is_empty() {
            let stable = message.is_some() || step.finish.as_ref().is_none_or(|f| f != "length");
            if !stable {
                // 输出续写的空步骤不进入历史：Node 删除这条 assistant。
                turn.step = None;
                turn.messages.retain(|m| *m != assistant);
                self.node.push(now, Op::RemoveMessage(assistant));
                return;
            }
            if step.finish.as_ref().is_none_or(|f| f != "length") {
                turn.boundary = Some(assistant.clone());
            }
            self.complete_step(now, super::part_id(now, &ids()), None);
            return;
        }
        for (index, call) in calls.iter().enumerate() {
            let name = call["function"]["name"].as_str().unwrap_or("").to_owned();
            let tool = Tool {
                call: call["id"].as_str().unwrap_or("").to_owned(),
                part: super::part_id(now, &ids()),
                index,
                input: super::tool_input(call),
                name,
                started: None,
                done: false,
                wrapper: call[crate::tool_search::WRAPPER_KEY]
                    .as_str()
                    .map(str::to_owned),
            };
            let part = r::tool_part(
                &tool.part,
                &self.id,
                &assistant,
                (&tool.call, index, &tool.name),
                Some(super::tool_metadata(&tool).unwrap_or_else(|| json!({}))),
                r::pending_tool(&tool.name, &tool.input),
            );
            self.node.push(now, Op::Part(part));
            step.tools.push(tool);
        }
        self.node.turn.as_mut().unwrap().step = Some(step);
    }
}

#[path = "turn_tools.rs"]
mod turn_tools;
