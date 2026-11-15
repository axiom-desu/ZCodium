// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! `forkAssistant` over Node storage (spec rust-m11-node-storage §5.2): the
//! child is committed by Node's atomic fork bundle at the stored stable
//! boundary, then registered from its stored records like any cold session.
use super::Engine;
use crate::contract::StorageCommitFailure;
use crate::domain::{history::ResponseBoundary, node_journal::Op, session::Session};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use zcode_cli_protocol::Command;

impl Engine {
    pub(super) async fn node_fork(&mut self, c: &Command, b: ResponseBoundary) -> Result<Value> {
        let parent = c.session_id.as_deref().context("Session required")?;
        let s = &self.sessions[parent];
        let Some(boundary) = b.node_message.clone() else {
            return Ok(c.ack("rejected", s.revision, Some("guard.forkTargetNotStable")));
        };
        let now = self.clock.now();
        let child = self.new_session_id();
        // W4：fork 子会话继承父会话已冻结的 system 快照（上游 `buildForkedPromptSnapshotEntry`）。
        let inherited_prompt_system = self.sessions[parent]
            .prompt_system
            .clone()
            .filter(|snapshot| snapshot["cleared"] != true);
        let request = json!({"parent": parent, "boundary": boundary, "command": c.command_id,
            "revision": c.base_revision.unwrap_or(0.0), "selection": s.node_selection(),
            "execution": {"mode": s.mode.as_str(), "planEnabled": s.plan_enabled}});
        // 子会话由 Fork 写入在同一事务中创建；载体只承载这批写入。
        let mut carrier = Session::new(
            child.clone(),
            self.workspace.clone(),
            String::new(),
            String::new(),
            String::new(),
            self.clock.id(),
            now,
        );
        carrier.node.created = true;
        carrier.node.push(now, Op::Fork(request));
        let mut ack = c.ack("accepted", s.revision, None);
        ack["result"] = json!({"type": "forkAssistant", "sessionId": child});
        self.store
            .commit_receipt(
                &self.workspace,
                Some(&mut carrier),
                Some((c.key(), ack.clone())),
            )
            .await
            .context(StorageCommitFailure)?;
        self.durable_acks.insert(c.key());
        self.acks.insert(c.key(), ack.clone());
        self.ensure_session(&child).await?;
        if let Some(snapshot) = inherited_prompt_system {
            let session = self.sessions.get_mut(&child).expect("forked session");
            session.prompt_system = Some(snapshot.clone());
            session.node_prompt_system(now, snapshot);
            // 上游：快照写入失败只记 warning，不中断 fork（子会话首个请求会自行记录）。
            if let Err(error) = self.persist(&child, None).await {
                tracing::warn!(
                    target: "zcode::runtime",
                    event = "prompt_snapshot.fork_write_failed",
                    session_id = child,
                    error = %format!("{error:#}"),
                    "Forked prompt snapshot write failed"
                );
            }
        }
        self.tools.inherit_session(parent, &child).await?;
        Ok(ack)
    }
}
