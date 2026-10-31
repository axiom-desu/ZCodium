// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use super::Engine;
use crate::domain::session::Session;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use zcode_cli_protocol::Command;
impl Engine {
    pub(super) async fn create(&mut self, c: Command) -> Result<Value> {
        if c.session_id.is_some() || c.payload["workspaceId"] != self.workspace {
            bail!("Workspace identity mismatch");
        }
        let config = self.select(&c.payload["config"], None)?;
        self.validate_selection(&c.payload["config"])?;
        // Host 项目预留的稳定 ID：只拒绝覆盖已有/软删/活跃会话，不接管既有 runtime。
        let explicit_id = c.payload["sessionId"].as_str().map(str::to_owned);
        if let Some(id) = &explicit_id
            && (self.sessions.contains_key(id) || self.store.session_exists(id).await?)
        {
            bail!("sessionId already exists");
        }
        let additional_directories = crate::domain::session_runtime::directories(&c.payload);
        let mut first = c.payload.get("firstInput").cloned();
        if let Some(input) = &first {
            self.validate_input(input)?;
            anyhow::ensure!(
                crate::domain::shared_context::reference(input)?.is_none(),
                "New draft has no imported shared context"
            );
            self.select(input, Some(config.clone()))?;
        }
        let mut session = Session::new(
            explicit_id.unwrap_or_else(|| self.new_session_id()),
            self.workspace.clone(),
            config.provider_id.clone(),
            config.model_id.clone(),
            config.reasoning_level.clone(),
            self.clock.id(),
            self.clock.now(),
        );
        session.workspace_path = Some(self.workspace_path.clone());
        session.workspace_directory = Some(self.workspace_path.clone());
        // Node 初始模式：创建参数 → 项目偏好 → 配置文件 permission.mode → build。
        let state = self.initial_execution_state(&c.payload["config"]);
        session.mode = state.mode;
        session.plan_enabled = state.plan_enabled;
        // 本次运行冻结；cwd/workspace identity 不变，也不扩权。
        session.runtime.additional_directories = additional_directories;
        if let Some(mode) = c.payload["config"]["followupMode"].as_str() {
            session.followup_mode = mode.into();
        }
        let id = session.id.clone();
        let mut raw = None;
        if let Some(input) = &mut first {
            let selected = self.select(input, Some(config.clone()))?;
            // 历史保存用户原始提交：附件在 prepare_attachments 改写引用之前投影。
            raw = Some(super::input_history::Raw::of(input));
            session.attachments = self.prepare_attachments(&id, input, &selected).await?;
        }
        if let Some(servers) = c.payload.get("mcpServers") {
            self.tools.configure_mcp(&id, servers).await?;
        }
        self.sessions.insert(id.clone(), session);
        self.apply_selection(&id, config)?;
        let mut ack = c.ack("accepted", 0, None);
        ack["result"] = json!({"type":"createSession","sessionId":id});
        let mut turn = None;
        if let Some(input) = first {
            let mut input_command = c.clone();
            input_command.payload = input;
            input_command.session_id = Some(id.clone());
            let intent = self.node_admit_now(&id, &input_command, "createSession");
            let (t, _) = self.admit_input(&id, &input_command, None)?;
            self.node_prompt(&id, &t, &input_command, (intent, None));
            turn = Some(t);
            if let Some(raw) = raw {
                self.record_input_history(&id, &input_command.payload, "prompt", raw);
            }
            // 与 Node 一致：inputId 即提交该输入的 commandId（也是模型请求的 query id）。
            ack["result"]["input"] = json!({"delivery":"startNow","inputId":c.command_id});
        }
        self.publish(&id, vec![])?;
        ack["revisionAtDecision"] = self.sessions[&id].revision.into();
        // draft 仅存内存，第一次输入才持久化；create 的幂等 ACK 与 durable session 一起提交。
        self.sessions.get_mut(&id).unwrap().creation_ack = Some((c.key(), ack.clone()));
        if turn.is_some() {
            self.persist(&id, Some((c.key(), ack.clone()))).await?;
        }
        self.acks.insert(c.key(), ack.clone());
        if let Some(turn) = turn {
            self.start_run(&id, turn)?;
        }
        Ok(ack)
    }
}
