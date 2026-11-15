//! 会话事实到 row/legacy 事件的投影（`Engine::project_stream`）。
//! 拆分自 `event_projection.rs`，函数体逐字搬移（只把捕获的局部量改成参数），
//! 只为把源文件保持在 400 行上限内。
use super::Engine;
use crate::contract::Event;
use anyhow::{Result, bail};
use serde_json::json;

impl Engine {
    pub(super) async fn project_stream(
        &mut self,
        id: &str,
        turn: &str,
        event: Event,
    ) -> Result<()> {
        self.telemetry_chunk(id, turn, &event);
        let now = self.clock.now();
        let s = self.sessions.get_mut(id).unwrap();
        let legacy = super::super::legacy_stream::fact(&event, s.runtime.legacy.kind().is_some());
        let mut deltas = vec![];
        let mut finished = false;
        let text_only = matches!(event, Event::Text { .. });
        let mut receipt = None;
        match event {
            Event::FilePrepared { .. }
            | Event::Todos { .. }
            | Event::Subagent { .. }
            | Event::GoalStep { .. }
            | Event::GoalVerdict { .. }
            | Event::SkillsInitialized { .. }
            | Event::TodoReminder { .. }
            | Event::PlanMode { .. }
            | Event::Reminder { .. }
            | Event::Hook(_)
            | Event::PermissionHook { .. }
            | Event::PromptBlocked { .. }
            | Event::WorkspaceHooks { .. }
            | Event::Question { .. }
            | Event::ToolCleanupFailed(_)
            | Event::ToolExecuting { .. }
            | Event::ModelStatus(_)
            | Event::ToolBatch { .. }
            | Event::StepBoundary { .. }
            | Event::Permission { .. }
            | Event::Background { .. }
            | Event::PromptInitialized { .. }
            | Event::InstructionsLoaded { .. }
            | Event::PromptSystem { .. }
            | Event::SessionFeatures { .. }
            | Event::ContextComposition { .. }
            | Event::AuxiliaryDone { .. }
            | Event::AuxiliaryReply { .. }
            | Event::HostCall { .. }
            | Event::HostRequest { .. }
            | Event::PluginCatalog { .. }
            | Event::TotalTokensBudget(_)
            | Event::ModelOnlyNotice { .. }
            | Event::StreamRecovery { .. }
            | Event::UsageDone { .. }
            | Event::RequestAuth { .. }
            | Event::RequestContext { .. }
            | Event::CompactStarted { .. }
            | Event::CompactDone { .. }
            | Event::CompactFailed { .. }
            | Event::ToolStreaming => unreachable!(),
            Event::Text {
                response_id,
                text,
                reasoning,
            } => {
                let kind = if reasoning {
                    "reasoning"
                } else {
                    "assistantText"
                };
                if let Some(row) = s
                    .rows
                    .iter_mut()
                    .rev()
                    .find(|r| r["assistantResponseId"] == response_id && r["kind"] == kind)
                {
                    let serde_json::Value::String(current) = &mut row["text"] else {
                        bail!("Invalid text projection");
                    };
                    if current.len() + text.len() > crate::domain::MAX_TEXT_BYTES {
                        bail!("Projected text exceeds limit");
                    }
                    current.push_str(&text);
                    deltas.push(
                        json!({"op":"row.delta","rowId":row["rowId"],"path":"text","append":text}),
                    );
                } else {
                    let mut row = s.row(kind, turn, &self.clock.id(), now);
                    row["assistantResponseId"] = response_id.into();
                    row["text"] = text.into();
                    row["state"] = "streaming".into();
                    s.rows.push(row.clone());
                    deltas.push(json!({"op":"row.appended","row":row}));
                }
            }
            Event::ModelDone {
                stable,
                message,
                usage,
                committed,
            } => {
                receipt = Some(committed);
                let index = s.messages.len();
                if let Some(message) = message {
                    s.append_message(message);
                }
                for row in &mut s.rows {
                    if row["turnId"] == turn && row["state"] == "streaming" {
                        row["state"] = "complete".into();
                        deltas.push(json!({"op":"row.upserted","row":row}));
                    }
                }
                if stable {
                    s.record_response(turn);
                }
                let request = self.active.get_mut(id).and_then(|a| a.request.take());
                super::super::usage_state::step_done(s, request, &usage, (index, now));
            }
            Event::ToolStart { call } => {
                let call_id = call["id"].as_str().unwrap();
                let mut row = s.row("toolCall", turn, call_id, now);
                row["toolCallId"] = call["id"].clone();
                row["toolName"] = call["function"]["name"].clone();
                row["inputText"] = call["function"]["arguments"].clone();
                row["status"] = "running".into();
                row["startedAt"] = now.into();
                s.rows.push(row.clone());
                deltas.push(json!({"op":"row.appended","row":row}));
            }
            Event::ToolDone {
                id: call_id,
                result,
                model_content,
                display,
                failed,
                denied,
                committed,
                ..
            } => {
                receipt = Some(committed);
                let content = model_content.unwrap_or_else(|| result.clone().into());
                s.append_message(json!({"role":"tool","tool_call_id":call_id,"content":content,"_zcode_tool_failed":failed}));
                let done = super::super::tool_rows::Done {
                    result: &result,
                    display: display.as_ref(),
                    failed,
                    denied,
                };
                if let Some(row) =
                    super::super::tool_rows::finish_call(s, (turn, &call_id), now, done)
                {
                    deltas.push(json!({"op":"row.upserted","row":row}));
                }
            }
            Event::Finished {
                error,
                model_failure,
                cancelled,
            } => {
                // cancel 可在 loop 正常返回与 Finished 入队之间到达，以 owner 的取消事实为准。
                let cancelled = cancelled || self.active[id].cancel.is_cancelled();
                super::super::busy_input::fallback_guides(
                    (s, now),
                    if cancelled || error.is_some() {
                        "guide.turnInterrupted"
                    } else {
                        "guide.noToolBoundary"
                    },
                );
                finished = true;
                s.api_retry = None;
                s.run_id = None;
                // 修复：后台子代理的权限请求挂在根会话上、由子会话持有，根 run 结束不能把它们一起清掉，
                // 否则子会话仍在等待却再也无法应答。
                let waiters = &self.waiters;
                s.pending.retain(|p| {
                    p["interactionId"]
                        .as_str()
                        .and_then(|i| waiters.permission(i))
                        .is_some_and(|w| w.owner != id)
                });
                s.revision += 1;
                let outcome = if cancelled {
                    "interrupted"
                } else if error.is_some() {
                    "failed"
                } else {
                    "success"
                };
                tracing::info!(
                    target: "zcode::runtime",
                    event = "run.finished",
                    session_id = id,
                    outcome,
                    failure = model_failure.as_ref().map(|f| f.reason),
                    "Run finished"
                );
                s.phase = match outcome {
                    "interrupted" => crate::domain::execution::Phase::CompletedInterrupted,
                    "failed" => crate::domain::execution::Phase::Error,
                    _ => crate::domain::execution::Phase::CompletedSuccess,
                };
                if cancelled || error.is_some() {
                    if s.queued_now.is_none() {
                        s.auto_drain = false;
                    }
                    s.close_unfinished_tools();
                }
                if !cancelled && let Some(message) = error {
                    s.last_error = Some(
                        json!({"code":"fault.runtime.execution","message":message,"recoverable":true,"at":now,"source":"runtime"}),
                    );
                    if let Some(failure) = model_failure {
                        let error = failure.last_error((&s.provider, &s.model), now);
                        s.last_error = Some(error);
                    }
                }
                s.finish_rows(outcome, now);
                // Node `persistDurableSessionEvent`(TurnComplete/TurnError)：终态结果先落库再发布，
                // 否则冷启动只能把全部历史任务推导成成功。outcome 与 Node 同值域。
                let last_outcome = match outcome {
                    "interrupted" => "interrupted",
                    "failed" => "error",
                    _ => "completed",
                };
                s.node_last_outcome(now, last_outcome);
                deltas.extend(
                    s.rows
                        .iter()
                        .filter(|r| r["turnId"] == turn)
                        .map(|r| json!({"op":"row.upserted","row":r})),
                );
                self.active.remove(id);
            }
        }
        s.updated_at = now;
        let checkpoint = !text_only || now.saturating_sub(s.checkpoint_at) >= 250;
        if checkpoint {
            s.checkpoint_at = now;
        }
        if finished {
            deltas.extend(self.turn_file_changes(id, turn).await?);
            // 持久事实（含 last_outcome）必须早于终态事件发布；现有 persist 收口复用，不开第二套事务。
            self.persist(id, None).await?;
        }
        self.publish(id, deltas)?;
        self.legacy_fact(id, turn, legacy)?;
        // 终态已在发布前提交过：同一 durable 事实不能写两次，否则接受该提交的调用方
        // （如 Node `persistDurableSessionEvent` 的单一收口）会看到多余的 barrier。
        if checkpoint && !finished {
            self.persist(id, None).await?;
        }
        if let Some(receipt) = receipt {
            let _ = receipt.send(());
        }
        if finished {
            self.promote(id).await?;
            self.deliver_children(id).await?;
            self.finish_child(id).await?;
        }
        Ok(())
    }
}
