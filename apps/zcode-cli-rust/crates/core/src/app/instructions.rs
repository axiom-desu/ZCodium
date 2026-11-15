//! 上游 3.18.2 F1：指令公告的读取缓存与每条请求的增量公告。
//! 语义见 `.agents/specs/upstream-3.18-rust-context.md`。
//!
//! 读取缓存的所有者是 Engine 的 `Session`（`instructions` + `instructions_boundary`）：
//! 只有会话开始与 compaction 边界变化才重读宿主文件；「已公告什么」的唯一事实是模型历史里
//! `context_prefix` 提醒消息上的 `_zcode_instructions` 事实。
use super::context::RunContext;
use crate::contract::{ContextPort, Event, EventSink};
use crate::{
    domain::instruction_files::{self, Announcement, File, Reason},
    domain::prompt::InstructionSource,
};
use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// 上游 `buildInstructionSourceFile`：截断标记进正文，空正文不公告。
fn file_of(source: InstructionSource) -> Option<File> {
    let body = if source.truncated {
        let name = std::path::Path::new(&source.path)
            .file_name()
            .map_or_else(|| source.path.clone(), |n| n.to_string_lossy().into_owned());
        format!("{}\n\n[File truncated: {name}]", source.content)
    } else {
        source.content
    };
    let file = File::new(
        source.path,
        source.kind.unwrap_or_else(|| {
            if source.user {
                instruction_files::TYPE_USER.into()
            } else {
                instruction_files::TYPE_PROJECT.into()
            }
        }),
        &body,
    );
    (!file.body.is_empty()).then_some(file)
}

/// 重读作废判定（F1）：当前持有的任一文件在本次读取里变成 unreadable。
fn held_unreadable(held: &[File], unreadable: &[String]) -> bool {
    held.iter()
        .any(|file| unreadable.iter().any(|path| path == &file.path))
}

/// 读取缓存按压缩边界失效；重读后提交给 owner 才继续请求。
async fn ensure(
    context: &dyn ContextPort,
    history: &mut RunContext,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<()> {
    let boundary = history.state.offset;
    if history.instructions.is_some() && history.instructions_boundary == Some(boundary) {
        return Ok(());
    }
    let read = context.instructions(cancel).await?;
    let reread = history.instructions.is_some();
    // 修复依据（F1）：runtime 持有的文件这次读不出来时，整次重读作废、沿用旧内容；
    // 否则它会以“已删除”出现在增量公告里，模型丢失已经宣告的指令。
    if reread
        && let Some(held) = &history.instructions
        && held_unreadable(held, &read.unreadable)
    {
        tracing::warn!(
            target: "zcode::context",
            event = "context.instructions.reread_discarded",
            session_id = %sink.session_id,
            "Instruction re-read discarded because a held file was unreadable"
        );
        return Ok(());
    }
    let auto_memory = history.auto_memory;
    let files: Arc<[File]> = read
        .sources
        .into_iter()
        .filter(|source| {
            auto_memory || source.kind.as_deref() != Some(instruction_files::TYPE_AUTO_MEMORY)
        })
        .filter_map(file_of)
        .collect();
    let unreadable: Arc<[String]> = read.unreadable.into();
    // 同一进程里换了压缩边界是 compaction 重读；首次读取是会话开始。
    let reason = if reread {
        Reason::Compaction
    } else {
        Reason::SessionStart
    };
    let (committed, receipt) = oneshot::channel();
    sink.send(Event::InstructionsLoaded {
        files: files.clone(),
        unreadable: unreadable.clone(),
        boundary,
        committed,
    })
    .await?;
    super::durable::durable(receipt, cancel).await?;
    history.instructions = Some(files);
    history.instructions_unreadable = Some(unreadable);
    history.instructions_boundary = Some(boundary);
    history.instructions_reason = Some(reason);
    Ok(())
}

/// 这一步要追加的公告：没有完整公告时发整份，否则只发差异；两者都没有时不发。
/// `subagent` 说明 `injectAgentsMd` 关闭：不公告，也不把缓存当作已公告事实。
fn announcement(history: &RunContext) -> Option<(String, Announcement)> {
    let skip = history
        .agent_profile
        .as_ref()
        .is_some_and(|profile| profile.inject_agents_md == Some(false));
    let current: &[File] = match (&history.instructions, skip) {
        (_, true) | (None, false) => &[],
        (Some(files), false) => files,
    };
    let reason = history.instructions_reason.unwrap_or(Reason::SessionStart);
    match instruction_files::announced(&history.messages) {
        None => (!current.is_empty()).then(|| {
            (
                instruction_files::render_full(current),
                Announcement {
                    files: current.iter().map(File::record).collect(),
                    ..Default::default()
                },
            )
        }),
        Some(known) => {
            // 读不出来的路径不算删除（F1）；宿主读取失败不会进入 `current`。
            let unreadable = history.instructions_unreadable.as_deref().unwrap_or(&[]);
            let delta = instruction_files::delta(current, &known, reason, unreadable)?;
            let changed: Vec<File> = current
                .iter()
                .filter(|file| delta.files.iter().any(|record| record.path == file.path))
                .cloned()
                .collect();
            Some((
                instruction_files::render_delta(&changed, &delta.removed, reason),
                delta,
            ))
        }
    }
}

/// 每条请求的指令公告：落库（provider 可见的 model-only notice）后才进入模型请求。
pub(super) async fn announce(
    context: &dyn ContextPort,
    history: &mut RunContext,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<()> {
    ensure(context, history, sink, cancel).await?;
    let Some((body, announcement)) = announcement(history) else {
        return Ok(());
    };
    history.instructions_reason = None;
    let message = instruction_files::message(&body, &announcement);
    let (committed, receipt) = oneshot::channel();
    sink.send(Event::ModelOnlyNotice {
        source: instruction_files::SOURCE,
        body: body.clone(),
        message: message.clone(),
        metadata: Some(serde_json::json!({
            instruction_files::KEY: announcement.to_value(),
        })),
        committed,
    })
    .await?;
    super::durable::durable(receipt, cancel)
        .await
        .context("Instruction announcement commit failed")?;
    history.push(message);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(path: &str, body: &str, user: bool) -> InstructionSource {
        InstructionSource {
            path: path.into(),
            user,
            content: body.into(),
            truncated: false,
            kind: None,
        }
    }

    fn history(files: Vec<File>) -> RunContext {
        let mut history = RunContext::new(
            Default::default(),
            vec![json!({"role":"user","content":"hi"})],
            None,
            0,
        );
        history.instructions = Some(Arc::from(files));
        history.instructions_boundary = Some(0);
        history
    }

    #[test]
    fn a_file_block_carries_the_instruction_type_and_truncation_marker() {
        let project = file_of(source("/w/AGENTS.md", "  body  ", false)).unwrap();
        assert_eq!(project.kind, instruction_files::TYPE_PROJECT);
        assert_eq!(project.body, "body");
        let user = file_of(InstructionSource {
            truncated: true,
            ..source("/h/AGENTS.md", "body", true)
        })
        .unwrap();
        assert_eq!(user.kind, instruction_files::TYPE_USER);
        assert_eq!(user.body, "body\n\n[File truncated: AGENTS.md]");
        assert!(file_of(source("/w/AGENTS.md", "   ", false)).is_none());
    }

    #[test]
    fn first_step_announces_every_file_and_the_next_step_only_differ() {
        let files = vec![
            File::new("/w/AGENTS.md", instruction_files::TYPE_PROJECT, "one"),
            File::new("/h/AGENTS.md", instruction_files::TYPE_USER, "two"),
        ];
        let mut history = history(files);
        let (body, full) = announcement(&history).unwrap();
        assert!(body.starts_with(instruction_files::PREAMBLE));
        assert_eq!(full.files.len(), 2);
        assert!(full.is_full(), "the first announcement is full");

        // 模拟该公告已落库（canonical 消息上的事实是唯一来源）。
        history.push(instruction_files::message(&body, &full));
        assert!(announcement(&history).is_none(), "nothing changed");

        // compaction 重读后只剩改写过的 workspace 文件：只发差异与删除说明。
        history.instructions_reason = Some(Reason::Compaction);
        history.instructions = Some(Arc::from(vec![File::new(
            "/w/AGENTS.md",
            instruction_files::TYPE_PROJECT,
            "one changed",
        )]));
        let (delta, changed) = announcement(&history).unwrap();
        assert!(delta.contains("after the conversation was compacted"));
        assert!(delta.contains("Instructions no longer present: /h/AGENTS.md"));
        assert_eq!(changed.reason, Some(Reason::Compaction));
        assert_eq!(changed.files.len(), 1);
        assert!(!delta.starts_with(instruction_files::PREAMBLE));
    }

    #[test]
    fn a_file_that_cannot_be_read_is_not_announced_as_removed() {
        let files = vec![File::new(
            "/w/AGENTS.md",
            instruction_files::TYPE_PROJECT,
            "one",
        )];
        let mut history = history(files);
        let (body, full) = announcement(&history).unwrap();
        history.push(instruction_files::message(&body, &full));
        // 第二次读：工作区文件存在但读不出来（例如权限），不能当作删除。
        history.instructions = Some(Arc::from(Vec::new()));
        history.instructions_unreadable = Some(Arc::from(vec!["/w/AGENTS.md".to_string()]));
        history.instructions_reason = Some(Reason::Compaction);
        assert!(announcement(&history).is_none());
        assert!(held_unreadable(
            &[File::new(
                "/w/AGENTS.md",
                instruction_files::TYPE_PROJECT,
                "one"
            )],
            &["/w/AGENTS.md".to_string()]
        ));
        assert!(!held_unreadable(
            &[File::new(
                "/w/AGENTS.md",
                instruction_files::TYPE_PROJECT,
                "one"
            )],
            &["/h/AGENTS.md".to_string()]
        ));
    }
}
