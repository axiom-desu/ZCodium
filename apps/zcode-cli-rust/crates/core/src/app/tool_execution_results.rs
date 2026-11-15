//! 工具结果预算与落库（resultBudget 截断/持久化、`ToolDone` 提交）。
//! 拆分自 `tool_execution.rs`，函数体逐字搬移，只为把源文件保持在 400 行上限内。
use crate::contract::{Event, EventSink, ToolOutput, ToolPort};
use anyhow::Result;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Node `serializeOutput`'s resultBudget (spec rust-m5-tools §2.3).
pub(super) async fn apply_budget(
    tools: &dyn ToolPort,
    name: &str,
    (session, call): (&str, &str),
    output: &mut ToolOutput,
) {
    use crate::domain::result_budget::{self, Plan};
    let budget = result_budget::for_tool(name);
    let text = match result_budget::plan(&output.content, budget) {
        Plan::Inline => return,
        Plan::Truncate(text) => text,
        Plan::Persist => match tools.persist_result(session, call, &output.content).await {
            Ok(path) => result_budget::persisted(&output.content, &path),
            // 写入失败时退回截断：结果仍可见，原始大输出不进入模型上下文。
            Err(_) => result_budget::truncated(&output.content, budget),
        },
    };
    output.content = text;
    output.model_content = None;
    output.truncated = true;
}

pub(super) async fn commit(
    history: &mut super::super::context::RunContext,
    id: &str,
    output: ToolOutput,
    failed: bool,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<()> {
    let content = output.content;
    // 失败结果总是文本形态（Node：is_error 结果展平为 error-text）。
    let message = match output.model_content.clone().filter(|_| !failed) {
        Some(blocks) => blocks,
        None => Value::String(content.clone()),
    };
    history.push(
        json!({"role":"tool","tool_call_id":id,"content":message,"_zcode_tool_failed":failed}),
    );
    let (committed, receipt) = oneshot::channel();
    let checkpoint = (!failed)
        .then(|| crate::domain::node_journal::checkpoint::candidate(&output.data))
        .flatten()
        .map(Box::new);
    let facts = crate::contract::ToolFacts {
        exit_code: output.data["exitCode"].as_i64(),
        truncated: output.truncated,
        model_usage: Some(output.data["modelUsage"].clone())
            .filter(|u| u.as_object().is_some_and(|u| !u.is_empty())),
        perf: output.perf,
        error: output.error,
    };
    sink.send(Event::ToolDone {
        id: id.into(),
        result: content,
        model_content: output.model_content.filter(|_| !failed),
        display: output.display,
        failed,
        denied: output.denied,
        checkpoint,
        facts,
        committed,
    })
    .await?;
    super::super::durable::durable(receipt, cancel).await
}
