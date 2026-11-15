//! `Session` 的生命周期/行投影方法。拆分自 `session.rs`，内容逐字搬移，
//! 只为把源文件保持在 400 行上限内（结构体与 serde 形状仍在 `session.rs`）。
use super::Session;
use serde_json::{Value, json};

impl Session {
    pub fn new(
        id: String,
        workspace: String,
        provider: String,
        model: String,
        reasoning_level: String,
        epoch: String,
        now: u64,
    ) -> Self {
        Self {
            node: Default::default(),
            file_checkpoints: vec![],
            imported_checkpoints: vec![],
            cold_context_used: None,
            cache_hits: Default::default(),
            event_seq: 0,
            rewind_committed: None,
            history: Default::default(),
            row_highwater: 0,
            history_rewrite: false,
            agent_profile: None,
            children: Default::default(),
            mailbox: vec![],
            goal: None,
            skills: None,
            shared_context: None,
            legacy_shared_context: false,
            workspace_path: None,
            workspace_directory: None,
            trace_id: None,
            runtime_trace: None,
            todos: vec![],
            todos_updated_at: now,
            prompt_snapshot: None,
            instructions: None,
            instructions_boundary: None,
            instructions_unreadable: None,
            session_features: Default::default(),
            context_composition: None,
            context_composition_revision: 0,
            total_tokens: Default::default(),
            prompt_system: None,
            stored_env: None,
            context: Default::default(),
            context_tokens: None,
            compact_instructions: None,
            queued_now: None,
            pending_acks: Default::default(),
            mode: super::super::execution::Mode::Build,
            plan_enabled: false,
            plan_transition: None,
            permission_grant: None,
            needs_plan_exit_reminder: false,
            last_assistant_mode: None,
            runtime: Default::default(),
            parent_id: None,
            task_type: super::interactive(),
            archived_at: None,
            archived: false,
            listed: true,
            attachments: Default::default(),
            background: Default::default(),
            id,
            workspace,
            provider,
            model,
            reasoning_level,
            thought_levels: vec![],
            epoch,
            title: String::new(),
            title_source: "default".into(),
            seq: 0,
            revision: 0,
            created_at: now,
            updated_at: now,
            phase: super::super::execution::Phase::Draft,
            rows: vec![],
            messages: vec![],
            saved_rows: 0,
            resident_bytes: None,
            topic: Default::default(),
            saved_inputs: 0,
            saved_responses: 0,
            saved_messages: 0,
            checkpoint_at: 0,
            api_retry: None,
            usage: json!({"contextWindow":null,"cumulative":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}}),
            last_error: None,
            creation_ack: None,
            pending: vec![],
            queue: vec![],
            auto_drain: true,
            followup_mode: super::queue_mode(),
            run_id: None,
        }
    }
    pub fn active_context_tokens(&mut self) -> usize {
        *self.context_tokens.get_or_insert_with(|| {
            super::super::context::estimate(&self.messages[self.context.offset..])
                + super::super::context::estimate(&super::super::context::with_summary(
                    self.context.summary.as_deref(),
                    &[],
                ))
        })
    }
    pub fn append_message(&mut self, message: Value) {
        // canonical 消息只有 actor 追加；估算随追加增量更新，避免长历史每轮重复扫描。
        if let Some(tokens) = &mut self.context_tokens {
            *tokens += super::super::context::estimate(std::slice::from_ref(&message));
        }
        if message["role"] == "assistant" {
            self.last_assistant_mode = Some(self.mode.as_str().into());
        }
        self.runtime.fresh = false;
        self.messages.push(message);
    }
    pub fn ended(&self) -> bool {
        self.phase.ended()
    }
    pub fn running(&self) -> bool {
        self.run_id.is_some()
    }
    pub fn current_rows_start(&self) -> usize {
        self.rows
            .iter()
            .rposition(|row| row["kind"] == "turnHeader")
            .unwrap_or(0)
    }
    pub fn row(&mut self, kind: &str, turn: &str, entity: &str, now: u64) -> Value {
        self.row_highwater = self.row_highwater.max(
            self.rows
                .last()
                .and_then(|r| r["rowId"].as_u64())
                .unwrap_or(0),
        ) + 1;
        json!({"rowId":self.row_highwater,
            "turnId":turn,"productTurnId":turn,"entityId":entity,"kind":kind,"createdAt":now,"createdAtSeq":self.seq+1})
    }
    pub fn recover(&mut self, epoch: String, now: u64) {
        for task in self.children.values_mut() {
            if task.running() {
                task.status = "lost".into();
                task.ended_at = Some(now);
                task.notified = true;
                task.output =
                    "Child execution was interrupted by runtime exit; it was not replayed.".into();
            }
        }
        if let Some(context) = &mut self.shared_context {
            context.release(None);
        }
        self.epoch = epoch;
        self.seq = 0;
        self.run_id = None;
        self.api_retry = None;
        self.pending.clear();
        self.queue.clear();
        for task in self.background.values_mut() {
            if task.status == "running" {
                task.status = "interrupted".into();
                task.ended_at = Some(now);
            }
        }
        if matches!(
            self.phase,
            super::super::execution::Phase::Running | super::super::execution::Phase::Prewarming
        ) {
            self.phase = super::super::execution::Phase::CompletedInterrupted;
            self.auto_drain = false;
            self.finish_rows("interrupted", now);
            // 崩溃可能发生于 assistant tool_calls 已保存但 tool result 尚未返回；
            // 补齐取消结果只用于模型语法恢复，绝不能重新执行有副作用的工具。
            self.close_unfinished_tools();
        }
        self.recover_subagent_rows();
        // Node onSessionResumed：重启后不可能仍在运行的 hook 行收口为失败（执行项为 cancelled）。
        for row in &mut self.rows {
            crate::hooks::projection::close_running(row, now);
        }
    }
}
