//! Node `core/src/tool/search/exposure.ts`：目录分类、请求暴露与增量公告。
use super::discovery::collect_discovered;
use super::projection::project_messages;
use super::{
    Candidate, DEFERRED_TOOL_CALL_NAME, Metadata, Mode, ResolvedMode, TOOL_SEARCH_NAME, candidate,
    definition_name, resolve_mode,
};
use crate::model::ToolSearchCapability;
use serde_json::Value;
use std::collections::BTreeSet;

pub const ADDED_TOOLS_NOTICE: &str = "The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query \"select:<name>[,<name>...]\" to load tool schemas before calling them:";
pub const LOCAL_ADDED_TOOLS_NOTICE: &str = "The following deferred tools are available via ToolSearch. Use query \"select:<name>[,<name>...]\" to load their complete schemas, then call them through DeferredToolCall with {name, input}. Call resident tools directly:";

/// 一次请求准备的输入：过滤后的完整候选目录与真实历史。
pub struct ExposureInput<'a> {
    pub mode: Mode,
    pub capability: Option<ToolSearchCapability>,
    pub supports_tool_call: bool,
    pub tools: &'a [Value],
    /// Node `ToolRegistry.get(name).metadata`；MCP 元数据来自 `_meta`/配置。
    pub metadata: &'a (dyn Fn(&str) -> Metadata + Sync),
    pub messages: &'a [Value],
    pub compact_discovered: &'a [String],
}

/// 请求暴露的派生结果（唯一派生，不写历史）。
#[derive(Debug)]
pub struct Exposure {
    pub tools: Vec<Value>,
    pub messages: Vec<Value>,
    pub loaded_call_ids: BTreeSet<String>,
    pub enabled: bool,
    pub mode: ResolvedMode,
    /// 启用的原生协议标记（只有 Native 为 true）。
    pub native: bool,
    pub catalog: Vec<Candidate>,
    pub deferred: BTreeSet<String>,
    /// Local 投影使用完整目录（含未展开的 deferred 定义）。
    pub projection_tools: Vec<Value>,
    pub discovered: BTreeSet<String>,
    pub pre_compact_discovered: BTreeSet<String>,
    pub reason: &'static str,
}

pub(super) struct Catalog {
    pub catalog: Vec<Candidate>,
    pub deferred: BTreeSet<String>,
    pub enabled: bool,
    pub mode: ResolvedMode,
    pub reason: &'static str,
}

pub(super) fn resolve_catalog_for_announcement(
    input: &ExposureInput<'_>,
    pre_compact: &BTreeSet<String>,
) -> Result<Catalog, &'static str> {
    let requested = resolve_mode(input.mode, input.capability, input.supports_tool_call)?;
    let mut has_configured_deferred = false;
    let mut catalog = vec![];
    for definition in input.tools {
        let name = definition_name(definition);
        if requested != ResolvedMode::Local && name == DEFERRED_TOOL_CALL_NAME {
            continue;
        }
        let metadata = (input.metadata)(name);
        let configured = super::is_deferred(name, &metadata);
        has_configured_deferred |= configured;
        let mut item = candidate(definition, &metadata);
        // Local 已提升（有效检查点）的原 deferred 工具恢复为普通工具。
        item.deferred =
            configured && !(requested == ResolvedMode::Local && pre_compact.contains(name));
        catalog.push(item);
    }
    let deferred: BTreeSet<String> = catalog
        .iter()
        .filter(|tool| tool.deferred)
        .map(|tool| tool.name.clone())
        .collect();
    let controls = catalog.iter().any(|tool| tool.name == TOOL_SEARCH_NAME)
        && (requested != ResolvedMode::Local
            || catalog
                .iter()
                .any(|tool| tool.name == DEFERRED_TOOL_CALL_NAME));
    // 全部提升后仍需控制入口处理后续目录变化，不能用剩余 deferred 数量关闭 Local。
    let enabled = requested != ResolvedMode::Off && has_configured_deferred && controls;
    let mode = if enabled {
        requested
    } else {
        ResolvedMode::Off
    };
    let reason = if enabled {
        mode.as_str()
    } else if requested == ResolvedMode::Off {
        "provider_disabled"
    } else if !has_configured_deferred {
        "no_deferred_tools"
    } else {
        "tool_unavailable"
    };
    Ok(Catalog {
        catalog,
        deferred,
        enabled,
        mode,
        reason,
    })
}

/// Node `buildToolExposure`：一次请求的 tools/messages/启用标记与执行 context。
pub fn build_exposure(input: &ExposureInput<'_>) -> Result<Exposure, &'static str> {
    let discovered = collect_discovered(input.messages, input.compact_discovered);
    let pre_compact: BTreeSet<String> = input.compact_discovered.iter().cloned().collect();
    let resolved = resolve_catalog_for_announcement(input, &pre_compact)?;
    let mut tools = vec![];
    for definition in input.tools {
        let name = definition_name(definition);
        if name == TOOL_SEARCH_NAME {
            if resolved.enabled {
                let mut definition = definition.clone();
                // 控制入口文案由真实模式决定，不沿用其它模式的旧定义。
                definition["function"]["description"] = if resolved.mode == ResolvedMode::Local {
                    super::local_description().into()
                } else {
                    super::native_description().into()
                };
                tools.push(definition);
            }
            continue;
        }
        if name == DEFERRED_TOOL_CALL_NAME {
            if resolved.mode == ResolvedMode::Local {
                tools.push(definition.clone());
            }
            continue;
        }
        let keep = resolved.mode == ResolvedMode::Off
            || !resolved.deferred.contains(name)
            || (resolved.mode == ResolvedMode::Native && discovered.contains(name));
        if !keep {
            continue;
        }
        let mut definition = definition.clone();
        definition.as_object_mut().unwrap().remove("deferLoading");
        if resolved.mode == ResolvedMode::Native && resolved.deferred.contains(name) {
            definition["deferLoading"] = true.into();
        }
        tools.push(definition);
    }
    // Local 使用完整目录投影：常驻控制入口以实际发送的定义覆盖原文案。
    let full: Vec<Value> = if resolved.mode == ResolvedMode::Local {
        input.tools.iter().chain(tools.iter()).cloned().collect()
    } else {
        tools.clone()
    };
    let projection = project_messages(input.messages, resolved.mode, &full, &resolved.deferred);
    Ok(Exposure {
        tools,
        messages: projection.messages,
        loaded_call_ids: projection.loaded_call_ids,
        enabled: resolved.enabled,
        mode: resolved.mode,
        native: resolved.mode == ResolvedMode::Native,
        catalog: resolved.catalog,
        deferred: resolved.deferred,
        projection_tools: full,
        discovered,
        pre_compact_discovered: pre_compact,
        reason: resolved.reason,
    })
}
