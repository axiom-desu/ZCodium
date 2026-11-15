//! ToolSearch/DeferredToolCall 的请求内执行上下文。
//! 拆分自 `tool_search.rs`，函数体逐字搬移，只为把源文件保持在 400 行上限内。
use crate::contract::ToolOutput;
use crate::domain::tool_search::{
    self, Candidate, DEFERRED_TOOL_CALL_NAME, ResolvedMode, TOOL_SEARCH_NAME,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// 请求内可执行的搜索上下文（不跨请求缓存）。
#[derive(Clone)]
pub(crate) struct SearchContext {
    pub enabled: bool,
    pub mode: ResolvedMode,
    pub catalog: Vec<Candidate>,
    pub discovered: BTreeSet<String>,
    pub definitions: Vec<Value>,
}

impl SearchContext {
    /// Node `toolSearchToolEntry.handler`：只读搜索，输出真实引用。
    pub(crate) fn execute(&self, args: &Value) -> Result<ToolOutput> {
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
    pub(crate) fn unwrap_call(&self, args: &Value) -> Result<(String, Value)> {
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
