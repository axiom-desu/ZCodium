use super::{Engine, Event, RunEvent};
use anyhow::Result;
impl Engine {
    pub(super) async fn apply_event(&mut self, event: RunEvent) -> Result<()> {
        if let Some(job) = self.auxiliary.get(&event.session_id) {
            if job.title.is_some()
                && let Event::AuxiliaryDone { result } = event.event
            {
                return self.title_done(&event.session_id, result).await;
            }
            return self.auxiliary_event(event);
        }
        if let Event::ToolCleanupFailed(message) = event.event {
            return self.cleanup_failed(&event.session_id, &event.run_id, message);
        }
        let Some(event) = self.hook_side(event).await? else {
            return Ok(());
        };
        let Some(event) = self.plugin_side(event).await? else {
            return Ok(());
        };
        // 3.18 F14：Host 权威请求（strict params）在进入会话投影前由 Engine 应答。
        let Some(event) = self.automation_side(event) else {
            return Ok(());
        };
        if let Event::Background { task, committed } = event.event {
            return self
                .background_event(&event.session_id, &event.run_id, task, committed)
                .await;
        }
        let id = event.session_id;
        let Some(active) = self.active.get(&id) else {
            return Ok(());
        };
        if active.run_id != event.run_id {
            return Ok(());
        }
        self.observe_event(&id, &event.event).await?;
        let active = &self.active[&id];
        // 取消后的 failed(cancelled) 状态也要记入 session/debug（Node 同样发出）。
        if let Event::ModelStatus(status) = event.event {
            let turn = active.turn_id.clone();
            self.model_status(&id, &turn, status);
            return Ok(());
        }
        if let Event::ToolStreaming = event.event {
            return self.ttft_tool(&id);
        }
        // 3.18 F2：预算只在 owner 的内存里；不产生事件、也不落库。
        if let Event::TotalTokensBudget(budget) = event.event {
            if let Some(session) = self.sessions.get_mut(&id) {
                session.total_tokens = budget;
            }
            return Ok(());
        }
        if let Event::StreamRecovery { retry, max, reply } = event.event {
            let turn = active.turn_id.clone();
            return self.stream_recovery(&id, &turn, (retry, max), reply).await;
        }
        let cancelled = active.cancel.is_cancelled();
        if cancelled && !matches!(event.event, Event::Finished { .. }) {
            return Ok(());
        }
        if matches!(
            event.event,
            Event::SkillsInitialized { .. }
                | Event::PromptInitialized { .. }
                | Event::InstructionsLoaded { .. }
                | Event::PromptSystem { .. }
                | Event::SessionFeatures { .. }
                | Event::ContextComposition { .. }
                | Event::RequestContext { .. }
                | Event::CompactStarted { .. }
                | Event::CompactDone { .. }
                | Event::CompactFailed { .. }
        ) {
            return self.context_event(&id, event.event).await;
        }
        let turn = active.turn_id.clone();
        if let Event::ToolExecuting { id: call } = &event.event {
            self.legacy_tool_executing(&id, &turn, call);
            return Ok(());
        }
        if let Event::ToolBatch { ids } = event.event {
            self.legacy_tool_batch(&id, &turn, ids);
            return Ok(());
        }
        if matches!(event.event, Event::FilePrepared { .. }) {
            return self.file_checkpoint_event(&id, event.event).await;
        }
        if matches!(event.event, Event::Subagent { .. }) {
            return self.subagent_event(&id, event.event).await;
        }
        if matches!(
            event.event,
            Event::GoalStep { .. } | Event::GoalVerdict { .. }
        ) {
            return self.goal_event(&id, event.event).await;
        }
        if let Event::Todos {
            call_id,
            write,
            reply,
        } = event.event
        {
            return self.todo_tool(&id, &call_id, write, reply).await;
        }
        if matches!(
            event.event,
            Event::TodoReminder { .. } | Event::PlanMode { .. } | Event::Reminder { .. }
        ) {
            return self.plan_event(&id, event.event).await;
        }
        if let Event::Question {
            call_id,
            input,
            reply,
        } = event.event
        {
            return self
                .register_question(&id, &event.run_id, &call_id, *input, reply)
                .await;
        }
        if let Event::Permission {
            call,
            request,
            reply,
        } = event.event
        {
            if reply.is_closed() {
                return Ok(());
            }
            let host = self.register_permission(&id, &call, request, reply)?;
            if host != id {
                self.persist(&host, None).await?;
            }
            return self.persist(&id, None).await;
        }
        if let Event::StepBoundary { committed } = event.event {
            if let Some(messages) = self.drain_mailbox(&id, &turn).await? {
                let _ = committed.send(Some(crate::contract::Guide {
                    messages,
                    origin: None,
                    tool_disallowlist: vec![],
                }));
                return Ok(());
            }
            return self.drain_guide(&id, &turn, committed).await;
        }
        if let Event::RequestAuth {
            provider,
            selection,
            access,
            reply,
        } = event.event
        {
            self.request_auth(&id, &turn, provider, selection, access, reply);
            return Ok(());
        }
        if matches!(event.event, Event::Finished { .. }) {
            // run 结束：权限、问答与 Host 请求统一在此收口，不再分散清理。
            self.release_waiters(&id);
        }
        self.project_stream(&id, &turn, event.event).await
    }
}

#[path = "event_projection_stream.rs"]
mod stream;
