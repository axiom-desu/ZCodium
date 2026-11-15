//! 生成元数据 ≠ 工具注册：ToolSearch 候选只来自真实注册目录。
//!
//! `domain/src/tool_search_metadata.json` 投影 TS `builtInTools` 的完整元数据（含 Rust 未实现的
//! native 工具，如 `SearchPlugins` / `SuggestPluginInstall` / app-control 会话工具）。元数据是
//! 按名字查表的附属事实，不注册也不暴露工具；本测试用真实 `definitions()` 证明孤立元数据键
//! 不会进入候选、搜索或执行面，因此不需要在 Rust 里另写一份工具名单去过滤。
use crate::domain::model::ToolSearchCapability;
use crate::domain::tool_search::{
    DEFERRED_TOOL_CALL_NAME, ExposureInput, Mode, build_exposure, definition_name, search_tools,
};
use serde_json::Value;
use std::collections::BTreeSet;

/// 生成元数据资产（与 `domain::tool_search::builtin_metadata` 同一文件）。
fn generated_metadata() -> Value {
    serde_json::from_str(include_str!("../../domain/src/tool_search_metadata.json"))
        .expect("generated tool metadata")
}

fn registered_names(definitions: &[Value]) -> BTreeSet<String> {
    definitions
        .iter()
        .map(|definition| definition_name(definition).to_owned())
        .collect()
}

fn native_exposure(definitions: &[Value]) -> crate::domain::tool_search::Exposure {
    let metadata = |name: &str| crate::domain::tool_search::builtin_metadata(name);
    let input = ExposureInput {
        mode: Mode::Native,
        capability: Some(ToolSearchCapability::new(true, false)),
        supports_tool_call: true,
        tools: definitions,
        metadata: &metadata,
        messages: &[],
        compact_discovered: &[],
    };
    build_exposure(&input).expect("native exposure")
}

#[test]
fn tool_search_candidates_are_exactly_the_registered_tools() {
    let definitions = crate::tool_definitions::definitions();
    let registered = registered_names(&definitions);
    assert!(registered.contains("ToolSearch"));
    let exposure = native_exposure(&definitions);
    let candidates: BTreeSet<String> = exposure
        .catalog
        .iter()
        .map(|candidate| candidate.name.clone())
        .collect();
    // Native 下控制入口 DeferredToolCall 不进候选；其余候选与注册目录一一对应，
    // 没有任何额外名字可以凭空出现。
    let expected: BTreeSet<String> = registered
        .iter()
        .filter(|name| name.as_str() != DEFERRED_TOOL_CALL_NAME)
        .cloned()
        .collect();
    assert_eq!(candidates, expected);
    for candidate in &exposure.catalog {
        assert!(registered.contains(&candidate.name), "{}", candidate.name);
    }
}

#[test]
fn metadata_only_tool_names_never_appear_or_execute() {
    let definitions = crate::tool_definitions::definitions();
    let registered = registered_names(&definitions);
    let metadata = generated_metadata();
    let metadata_names: BTreeSet<String> = metadata
        .as_object()
        .expect("metadata object")
        .keys()
        .cloned()
        .collect();
    // TS 注册但 Rust 未实现的 native 工具确实在生成元数据里（证明资产没被“过滤成支持面”）。
    assert!(metadata_names.contains("SearchPlugins"));
    assert!(metadata_names.contains("SuggestPluginInstall"));
    let unregistered: Vec<&String> = metadata_names.difference(&registered).collect();
    assert!(!unregistered.is_empty());

    let exposure = native_exposure(&definitions);
    let candidates: BTreeSet<String> = exposure
        .catalog
        .iter()
        .map(|candidate| candidate.name.clone())
        .collect();
    for name in &unregistered {
        assert!(
            !candidates.contains(*name),
            "{name} must not be a candidate"
        );
        // 选择/搜索都只读候选目录：孤立元数据键无法把自己的 schema 或结果塞回来。
        assert!(search_tools(&format!("select:{name}"), &exposure.catalog, 10).is_empty());
        assert!(!search_tools(name, &exposure.catalog, 10).contains(name));
        assert!(
            search_tools(name, &exposure.catalog, 10)
                .iter()
                .all(|hit| { candidates.contains(hit) && registered.contains(hit) })
        );
        // 执行面按目录分发：没有定义就没有 handler，名字不可执行。
        assert!(
            exposure
                .tools
                .iter()
                .all(|tool| { tool["function"]["name"].as_str() != Some(name.as_str()) })
        );
    }
}

#[test]
fn registered_deferred_tools_still_use_generated_metadata_by_name() {
    let definitions = crate::tool_definitions::definitions();
    let exposure = native_exposure(&definitions);
    let web_fetch = exposure
        .catalog
        .iter()
        .find(|candidate| candidate.name == "WebFetch")
        .expect("WebFetch is registered");
    assert!(web_fetch.deferred);
    assert!(web_fetch.search_hint.is_some());
    // 目录里确实存在 deferred 工具，否则上面的断言没有意义。
    assert!(exposure.catalog.iter().any(|candidate| candidate.deferred));
}
