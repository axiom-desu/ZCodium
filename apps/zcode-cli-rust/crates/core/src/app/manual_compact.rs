//! 手动压缩的摘要请求：与 agent step 相同的前缀、工具与 ToolSearch 投影。
use super::compaction::Trigger;
use crate::contract::{ContextPort, EventSink, ModelPort, ToolPort};
use anyhow::Result;
use tokio_util::sync::CancellationToken;

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    model: &dyn ModelPort,
    tools: &dyn ToolPort,
    context: &dyn ContextPort,
    history: &mut super::context::RunContext,
    (skills, profile): (
        &crate::domain::skills::SkillCatalog,
        Option<&crate::domain::subagent::Profile>,
    ),
    definitions: &[serde_json::Value],
    instructions: &str,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<()> {
    let bound = model.bind();
    let model = bound.as_deref().unwrap_or(model);
    let (prefix, _) =
        super::context::step_prefix(model, context, history, (skills, profile), cancel).await?;
    // compact 候选目录按 Node `compact-active.ts` 策略裁剪，发送 tools 用暴露结果。
    let prepared = super::tool_search::compact_preparation(
        model,
        tools,
        &sink.session_id,
        history,
        definitions,
    )?;
    let reminder = super::plan_tools::plan_reference(tools, sink).await?;
    let request = prepared.request(&prefix, definitions, reminder, tools);
    history
        .compact(model, sink, cancel, Trigger::Manual(instructions), request)
        .await?;
    Ok(())
}
