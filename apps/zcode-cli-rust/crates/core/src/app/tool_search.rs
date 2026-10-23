//! ToolSearch 的 Rust Core 接线（spec `.agents/specs/upstream-3.16-sync-s6.md`）：
//! 每步请求准备、`ToolSearch`/`DeferredToolCall` 执行边界、公告与 compact 检查点。
//!
//! 唯一可变事实仍是 `Session.messages` + `ContextState`；这里只派生请求内容并在
//! 既有提醒通道提交公告。`Glob`/`Grep` 的 `tool_search` 模块与本模块无关。
use super::compaction::Request;
use super::context::RunContext;
use crate::contract::{Event, EventSink, ModelPort, ModelRequestOptions, ToolOutput, ToolPort};
use crate::domain::tool_search::{
    self, ANNOUNCEMENT_KEY, ANNOUNCEMENT_SOURCE, Candidate, DEFERRED_TOOL_CALL_NAME, Metadata,
    ResolvedMode, TOOL_SEARCH_NAME, WRAPPER_KEY,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// 请求内可执行的搜索上下文（不跨请求缓存）。
#[derive(Clone)]
pub(super) struct SearchContext {
    pub enabled: bool,
    pub mode: ResolvedMode,
    pub catalog: Vec<Candidate>,
}

impl SearchContext {
    /// Node `toolSearchToolEntry.handler`：只读搜索，输出真实引用。
    pub(super) fn execute(&self, args: &Value) -> Result<ToolOutput> {
        if !self.enabled {
            bail!("ToolSearch is not enabled for this request.");
        }
        args.as_object()
            .context("ToolSearch input must be an object")?;
        let query = args["query"]
            .as_str()
            .context("ToolSearch query must be a string")?;
        // Node `z.number().optional().default(5)`：缺省补 5，null 不是数字；
        // 小数按 `Array#slice` 向零截断，负数从末尾倒数。未知键按非 strict zod 剥掉。
        let max_results = match args.get("max_results") {
            None => tool_search::DEFAULT_RESULTS as i64,
            Some(Value::Number(number)) => number
                .as_f64()
                .filter(|value| value.is_finite())
                .map(|value| value.trunc() as i64)
                .context("ToolSearch max_results must be a number")?,
            Some(_) => bail!("ToolSearch max_results must be a number"),
        };
        let matches = tool_search::search_tools(query, &self.catalog, max_results);
        let total_deferred = self.catalog.iter().filter(|tool| tool.deferred).count();
        let data = json!({
            "matches": matches,
            "query": query,
            "total_deferred_tools": total_deferred,
        });
        let mut output = ToolOutput::new(display_text(&matches), data);
        if !matches.is_empty() {
            // 原始历史保存真实引用，不保存 schema 快照或展开正文。
            output.model_content = Some(Value::Array(
                matches
                    .iter()
                    .map(|name| json!({"type": "tool_reference", "toolName": name}))
                    .collect(),
            ));
        }
        Ok(output)
    }

    /// `DeferredToolCall` 解包：只接受当前请求允许的 client-executed deferred 工具。
    pub(super) fn unwrap_call(&self, args: &Value) -> Result<(String, Value)> {
        if !self.enabled || self.mode != ResolvedMode::Local {
            bail!("DeferredToolCall is not available for this request.");
        }
        let Some((name, input)) = tool_search::deferred_input(args) else {
            bail!("Invalid DeferredToolCall input.");
        };
        let Some(candidate) = self.catalog.iter().find(|tool| tool.name == name) else {
            bail!("Tool not available in this request: {name}");
        };
        if name == TOOL_SEARCH_NAME
            || name == DEFERRED_TOOL_CALL_NAME
            || candidate.provider_native
            || !candidate.deferred
        {
            bail!(
                "Call {name} directly using its normal tool call; DeferredToolCall only accepts deferred tools."
            );
        }
        Ok((name, input))
    }
}

fn display_text(matches: &[String]) -> String {
    if matches.is_empty() {
        "No matching deferred tools found".into()
    } else {
        format!(
            "Found {} matching deferred tools: {}",
            matches.len(),
            matches.join(", ")
        )
    }
}

/// 一次请求的暴露决策（不依赖最终请求消息投影）。
pub(super) struct Plan {
    pub tools: Vec<Value>,
    pub options: ModelRequestOptions,
    pub search: Option<SearchContext>,
    pub mode: ResolvedMode,
    projection_tools: Vec<Value>,
    deferred: BTreeSet<String>,
}

impl Plan {
    /// 对最终请求消息做引用投影（含续写/临时提醒与前缀）。
    pub(super) fn project(&self, messages: &[Value]) -> Vec<Value> {
        tool_search::project_messages(messages, self.mode, &self.projection_tools, &self.deferred)
            .messages
    }
}

fn mode_error(error: &'static str) -> anyhow::Error {
    match error {
        "native_tool_search_unsupported" => {
            anyhow::anyhow!("--toolsearch-mode native requires an Anthropic Messages provider.")
        }
        "local_tool_search_requires_tool_calls" => {
            anyhow::anyhow!("--toolsearch-mode local requires a provider that supports tool calls.")
        }
        other => anyhow::anyhow!("ToolSearch request preparation failed: {other}"),
    }
}

/// Node `prepareRuntimeProviderRequest` 的 ToolSearch 部分：一次准备，主/子 Agent、
/// compact、Goal 复用同一入口；Memory extraction 由 Host 侧组装请求。
pub(super) fn plan(
    model: &dyn ModelPort,
    tools: &dyn ToolPort,
    session: &str,
    history: &RunContext,
    definitions: &[Value],
) -> Result<Plan> {
    let metadata = |name: &str| -> Metadata { tools.tool_search_metadata(session, name) };
    let supports_tool_call = model.supports_tool_call();
    let compact = history.state.pre_compact_discovered_tools.clone();
    let input = tool_search::ExposureInput {
        mode: history.tool_search_mode,
        capability: model.tool_search_capability(),
        supports_tool_call,
        tools: definitions,
        metadata: &metadata,
        messages: &history.messages,
        compact_discovered: &compact,
    };
    let exposure = tool_search::build_exposure(&input).map_err(mode_error)?;
    let search = exposure.enabled.then(|| SearchContext {
        enabled: exposure.enabled,
        mode: exposure.mode,
        catalog: exposure.catalog.clone(),
    });
    Ok(Plan {
        tools: exposure.tools,
        options: ModelRequestOptions {
            tool_search_enabled: exposure.native,
        },
        search,
        mode: exposure.mode,
        projection_tools: exposure.projection_tools,
        deferred: exposure.deferred,
    })
}

/// Node `compact-active.ts` 的 compact 候选策略：启用 ToolSearch 时只保留
/// Read / 两个控制入口 / MCP 工具；否则回退到非控制工具，并沿用 >100 清空阈值。
pub(super) fn compact_candidates(
    model: &dyn ModelPort,
    tools: &dyn ToolPort,
    session: &str,
    history: &RunContext,
    definitions: &[Value],
) -> Result<Vec<Value>> {
    let metadata = |name: &str| -> Metadata { tools.tool_search_metadata(session, name) };
    let focused: Vec<Value> = definitions
        .iter()
        .filter(|definition| {
            let name = tool_search::definition_name(definition);
            name == "Read"
                || name == TOOL_SEARCH_NAME
                || name == DEFERRED_TOOL_CALL_NAME
                || metadata(name).mcp.is_some()
        })
        .cloned()
        .collect();
    let trial = plan(model, tools, session, history, &focused)?;
    if trial.search.is_some() {
        return Ok(focused);
    }
    let mut fallback: Vec<Value> = definitions
        .iter()
        .filter(|definition| {
            !matches!(
                tool_search::definition_name(definition),
                TOOL_SEARCH_NAME | DEFERRED_TOOL_CALL_NAME
            )
        })
        .cloned()
        .collect();
    if fallback.len() > crate::domain::compact::MAX_SUMMARY_TOOLS {
        fallback.clear();
    }
    Ok(fallback)
}

/// compact 的候选目录与配套暴露（一次准备，调用方据此组装 `Request`）。
pub(super) fn compact_preparation(
    model: &dyn ModelPort,
    tools: &dyn ToolPort,
    session: &str,
    history: &RunContext,
    definitions: &[Value],
) -> Result<super::compact_request::Prepared> {
    let candidates = compact_candidates(model, tools, session, history, definitions)?;
    let plan = plan(model, tools, session, history, &candidates)?;
    Ok(super::compact_request::Prepared {
        tools: candidates,
        plan,
    })
}

/// 把模型调用里的合法 `DeferredToolCall` 重写为目标调用（同一 callID + 包装标记）。
/// 失败保持包装身份：执行时返回普通错误，不执行目标 Hook/审批/handler。
pub(super) fn admit(calls: &mut [Value], search: Option<&SearchContext>) {
    for call in calls {
        if call["function"]["name"].as_str() != Some(DEFERRED_TOOL_CALL_NAME) {
            continue;
        }
        let Some(search) = search else { continue };
        // 包装入参的严格校验在 unwrap_call 内完成；失败保留原调用。
        let args: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null);
        let Ok((name, input)) = search.unwrap_call(&args) else {
            continue;
        };
        call["function"]["name"] = name.into();
        call["function"]["arguments"] = crate::domain::js_json::stringify(&input).into();
        call[WRAPPER_KEY] = DEFERRED_TOOL_CALL_NAME.into();
    }
}

/// 工具批次后的公告收集（正常收集/compact 重建共用同一生成器）。
pub(super) async fn announce(
    model: &dyn ModelPort,
    tools: &dyn ToolPort,
    history: &mut RunContext,
    definitions: &[Value],
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<()> {
    let session = sink.session_id.as_str();
    let metadata = |name: &str| -> Metadata { tools.tool_search_metadata(session, name) };
    let supports_tool_call = model.supports_tool_call();
    let compact = history.state.pre_compact_discovered_tools.clone();
    let input = tool_search::ExposureInput {
        mode: history.tool_search_mode,
        capability: model.tool_search_capability(),
        supports_tool_call,
        tools: definitions,
        metadata: &metadata,
        messages: &history.messages,
        compact_discovered: &compact,
    };
    let announcement = tool_search::build_announcement(&input, &compact).map_err(mode_error)?;
    let Some((body, delta)) = announcement else {
        return Ok(());
    };
    let message = reminder_message(&body, &delta.to_value());
    let (committed, receipt) = oneshot::channel();
    sink.send(Event::ModelOnlyNotice {
        source: ANNOUNCEMENT_SOURCE,
        body,
        message: message.clone(),
        metadata: Some(json!({ANNOUNCEMENT_KEY: delta.to_value()})),
        committed,
    })
    .await?;
    // owner 提交并持久化后才进入模型请求；冷恢复与热会话前缀一致。
    super::durable::durable(receipt, cancel).await?;
    history.push(message);
    Ok(())
}

/// 公告的 canonical 消息（与 hydrate 重建的形状一致）。
pub(super) fn reminder_message(body: &str, delta: &Value) -> Value {
    json!({
        "role": "user",
        "content": crate::domain::node_history::reminders::wrap(ANNOUNCEMENT_SOURCE, body),
        "_zcode_source": ANNOUNCEMENT_SOURCE,
        ANNOUNCEMENT_KEY: delta.clone(),
    })
}

/// 成功 compact 的发现检查点：历史真实引用 + 上一检查点。
pub(super) fn compact_discovery(history: &RunContext) -> Vec<String> {
    tool_search::collect_discovered(
        &history.messages,
        &history.state.pre_compact_discovered_tools,
    )
    .into_iter()
    .collect()
}

/// Node turn `toolDisallowlist`：只从模型可见定义移除，执行边界仍按既有规则。
pub(super) fn hide(definitions: &mut Vec<Value>, disallowed: &[String]) {
    if !disallowed.is_empty() {
        definitions.retain(|d| {
            !disallowed
                .iter()
                .any(|name| d["function"]["name"] == name.as_str())
        });
    }
}

pub(super) fn definition_tokens(definitions: &[Value]) -> usize {
    definitions
        .iter()
        .map(|d| d.to_string().encode_utf16().count().div_ceil(3))
        .sum()
}

/// 包装调用准入 + 回写待持久化消息（同一 callID + 包装标记）。
pub(super) fn admit_output(
    mut output: crate::contract::ModelOutput,
    search: Option<&SearchContext>,
) -> crate::contract::ModelOutput {
    admit(&mut output.calls, search);
    rewrite_message_calls(&mut output);
    output
}

fn rewrite_message_calls(output: &mut crate::contract::ModelOutput) {
    let Some(calls) = output
        .message
        .get_mut("tool_calls")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for call in calls.iter_mut() {
        let id = call["id"].clone();
        if let Some(admitted) = output
            .calls
            .iter()
            .find(|candidate| candidate["id"] == id && candidate.get(WRAPPER_KEY).is_some())
            .cloned()
        {
            *call = admitted;
        }
    }
}

/// 成功 compact 的公告重建（与正常收集共用同一生成器）。
pub(super) fn compact_announcement(
    model: &dyn ModelPort,
    sink: &EventSink,
    request: &Request<'_>,
    mode: crate::domain::tool_search::Mode,
    preserved: &[Value],
    discovered: &[String],
) -> Option<(String, crate::domain::tool_search::Announcement)> {
    let metadata = |name: &str| -> crate::domain::tool_search::Metadata {
        request.port.tool_search_metadata(&sink.session_id, name)
    };
    let supports_tool_call = model.supports_tool_call();
    let input = crate::domain::tool_search::ExposureInput {
        mode,
        capability: model.tool_search_capability(),
        supports_tool_call,
        tools: request.tools,
        metadata: &metadata,
        messages: preserved,
        compact_discovered: discovered,
    };
    crate::domain::tool_search::build_announcement(&input, discovered)
        .ok()
        .flatten()
}
