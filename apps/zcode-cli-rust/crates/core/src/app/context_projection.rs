use super::Engine;
use crate::contract::Event;
use anyhow::{Result, ensure};
use serde_json::json;
impl Engine {
    pub(super) async fn context_event(&mut self, id: &str, event: Event) -> Result<()> {
        // 压缩事件的 `id` 是标记 id，会遮蔽会话 id。
        let session_id = id;
        self.node_compact(id, &event);
        let turn = self.active[id].turn_id.clone();
        let session = self.sessions.get_mut(id).unwrap();
        let mut deltas = vec![];
        let receipt;
        let mut compact_complete = None;
        match event {
            Event::SkillsInitialized { catalog, reply } => {
                // catalog RPC 可能先于发现事件完成；统一返回 owner 已提交的快照，避免两份能力目录。
                if session.skills.is_none() {
                    session.skills = Some(catalog);
                    self.persist(id, None).await?;
                }
                let _ = reply.send(self.sessions[id].skills.clone().unwrap());
                return Ok(());
            }
            Event::PromptInitialized {
                snapshot,
                skills,
                committed,
            } => {
                // 首次环境快照必须先提交；数据库失败时不得继续向模型发送未确定的请求上下文。
                ensure!(
                    session.prompt_snapshot.is_none(),
                    "Prompt snapshot already initialized"
                );
                session.prompt_snapshot = Some(*snapshot);
                session.stored_env = None;
                if session.skills.is_none() {
                    session.skills = Some(skills);
                }
                let now = self.clock.now();
                let session = self.sessions.get_mut(id).unwrap();
                session.node_prompt_snapshot(now);
                self.persist(id, None).await?;
                let _ = committed.send(self.sessions[id].skills.clone().unwrap());
                return Ok(());
            }
            // 3.18 F1：读取结果只做进程内缓存（会话开始与 compaction 后重读）。
            Event::InstructionsLoaded {
                files,
                unreadable,
                boundary,
                committed,
            } => {
                let session = self.sessions.get_mut(id).unwrap();
                session.instructions = Some(files);
                session.instructions_unreadable = Some(unreadable);
                session.instructions_boundary = Some(boundary);
                let _ = committed.send(());
                return Ok(());
            }
            // 3.18 F3：system 字节快照落库（覆盖写；compaction 成功时写 cleared）。
            Event::PromptSystem { data, committed } => {
                let now = self.clock.now();
                let cleared = data["cleared"] == true;
                let session = self.sessions.get_mut(id).unwrap();
                session.prompt_system = Some(data.clone());
                session.node_prompt_system(now, data);
                self.persist(id, None).await?;
                let _ = committed.send(());
                let _ = cleared;
                return Ok(());
            }
            // 3.18 F4：composition 只记录最近一次请求；revision 每会话递增（不落库）。
            Event::ContextComposition {
                categories,
                model,
                context_window,
            } => {
                let now = self.clock.now();
                let session = self.sessions.get_mut(id).unwrap();
                session.context_composition_revision += 1;
                let total: u64 = categories
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|category| category["tokens"].as_u64().unwrap_or(0))
                    .sum();
                session.context_composition = Some(serde_json::json!({
                    "sessionId": id,
                    "revision": session.context_composition_revision,
                    "phase": "request",
                    "measuredAt": now,
                    "model": {
                        "providerId": model.as_ref().and_then(|m| m["providerId"].as_str()).unwrap_or(""),
                        "modelId": model.as_ref().and_then(|m| m["modelId"].as_str()).unwrap_or(""),
                        "contextWindow": context_window,
                    },
                    "tokenMethod": "estimated",
                    "estimatedTokens": total,
                    "freeTokens": context_window.map(|window| window.saturating_sub(total)),
                    "categories": categories,
                }));
                return Ok(());
            }
            // 3.18 F12：能力标签只增不减，owner 并集后写 session_entry（last-wins）。
            Event::SessionFeatures { features } => {
                let now = self.clock.now();
                let session = self.sessions.get_mut(id).unwrap();
                let before = session.session_features.len();
                session.session_features.extend(features);
                if session.session_features.len() != before {
                    session.node_session_features(now);
                    self.persist(id, None).await?;
                }
                return Ok(());
            }
            Event::RequestContext { window, breakdown } => {
                if let Some(active) = self.active.get_mut(id) {
                    active.request = Some(super::usage_state::StepRequest { window, breakdown });
                }
                return Ok(());
            }
            Event::CompactStarted {
                id,
                manual,
                tokens,
                prefix,
                committed,
                ..
            } => {
                // Node 的压缩前 token 包含请求前缀（system prompt、上下文与技能提醒）。
                let tokens = tokens + prefix;
                let mut row = session.row("timelineMarker", &turn, &id, self.clock.now());
                row["lane"] = "assistantWork".into();
                row["marker"] = json!({"type":"compact","origin":if manual {"manual"} else {"auto"},"status":"running","tokensBefore":tokens});
                session.rows.push(row.clone());
                deltas.push(json!({"op":"row.appended","row":row}));
                receipt = Some(committed);
            }
            Event::CompactDone {
                id,
                context,
                tokens,
                prefix,
                usage,
                body,
                reminders,
                committed,
                ..
            } => {
                ensure!(
                    context.offset >= session.context.offset
                        && context.offset <= session.messages.len(),
                    "Invalid context boundary"
                );
                let changed = context.offset > session.context.offset;
                // Node：自动与反应式压缩成功后清零连续失败次数（手动压缩不影响）。
                let automatic = session
                    .rows
                    .iter()
                    .any(|r| r["entityId"] == id && r["marker"]["origin"] == "auto");
                if changed && automatic {
                    session.runtime.compact_failures = 0;
                }
                session.context = context;
                // 被摘要覆盖的提醒不再出现；计划文件提醒追加在保留消息之后并持久化。
                let offset = session.context.offset;
                session
                    .runtime
                    .reminders
                    .retain(|(anchor, _, _)| *anchor >= offset);
                for reminder in reminders {
                    session.append_message(reminder);
                }
                session.context_tokens = Some(tokens);
                // Node：轮内压缩的 ModelComplete 在本轮事件里，目标的 tokensUsed 包含它。
                if let Some(goal) = session.goal.as_mut() {
                    goal.account(&usage, self.clock.now());
                }
                // 修复：压缩摘要请求不是 main_turn，原先把它计入 cumulative；前后 token 也只估算
                // 会话消息。Node 的标记与 context 水位都含请求前缀，cumulative 不变（spec
                // rust-m9-usage-logs §4.2）。
                let tokens = tokens + prefix;
                if let Some(tally) = session.runtime.legacy.turn.as_mut() {
                    tally.compacted(&usage, changed, tokens as u64);
                }
                let summary = session.runtime.compact_summary.take();
                let window = changed
                    .then(|| self.model_window(&self.sessions[session_id]))
                    .flatten();
                let session = self.sessions.get_mut(session_id).unwrap();
                if changed {
                    super::usage_state::compacted(session, tokens, window);
                    compact_complete = Some((body, usage));
                    // 3.18 F3：压缩成功后 system 必须重建；内存为空也要写清除标记，
                    // 否则冷恢复会拿到压缩前那一行（上游 clearPromptSnapshot 的修复原因）。
                    let cleared = super::prompt_system::cleared();
                    session.prompt_system = Some(cleared.clone());
                    session.node_prompt_system(self.clock.now(), cleared);
                }
                let row = session
                    .rows
                    .iter_mut()
                    .find(|r| r["entityId"] == id)
                    .ok_or_else(|| anyhow::anyhow!("Compaction marker missing"))?;
                row["marker"]["status"] = if changed { "success" } else { "noop" }.into();
                row["marker"]["tokensAfter"] = tokens.into();
                if let Some(summary) = summary.filter(|_| changed) {
                    row["marker"]["summaryRef"] = summary.into();
                }
                deltas.push(json!({"op":"row.upserted","row":row}));
                receipt = Some(committed);
                session.revision += 1;
            }
            Event::CompactFailed { id, committed } => {
                let row = session
                    .rows
                    .iter_mut()
                    .find(|r| r["entityId"] == id)
                    .ok_or_else(|| anyhow::anyhow!("Compaction marker missing"))?;
                row["marker"]["status"] = "failed".into();
                if row["marker"]["origin"] == "auto" {
                    session.runtime.compact_failures += 1;
                }
                deltas.push(json!({"op":"row.upserted","row":row}));
                receipt = Some(committed);
            }
            _ => unreachable!(),
        }
        if let Some((summary, usage)) = compact_complete {
            self.legacy_compact_complete(id, &turn, &summary, &usage);
        }
        self.publish(id, deltas)?;
        if let Some(receipt) = receipt {
            self.persist(id, None).await?;
            let _ = receipt.send(());
        }
        Ok(())
    }
}
