//! Node `buildToolSearchAnnouncement`：公告正文与同一份增量 metadata。
//! 从 `exposure` 拆出以保持单文件在架构行数上限内。
use super::definition_name;
use super::discovery::{Announcement, announcement_delta};
use super::exposure::{
    ADDED_TOOLS_NOTICE, LOCAL_ADDED_TOOLS_NOTICE, resolve_catalog_for_announcement,
};
use super::{ExposureInput, ResolvedMode, resolve_mode};
use std::collections::{BTreeMap, BTreeSet};

const MAX_REMOVED_NAME_LINES: usize = 30;
const AMBIENT_CONTEXT_NOTICE: &str = "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";

/// Node `buildToolSearchAnnouncement`：正文与同一份增量 metadata。
pub fn build_announcement(
    input: &ExposureInput<'_>,
    compact_discovered: &[String],
) -> Result<Option<(String, Announcement)>, &'static str> {
    // Off 不需要公告或提升信息，保持关闭路径不扫描公告历史。
    if resolve_mode(input.mode, input.capability, input.supports_tool_call)? == ResolvedMode::Off {
        return Ok(None);
    }
    let (announced, listed) = announcement_delta(input.messages);
    let pre_compact: BTreeSet<String> = compact_discovered.iter().cloned().collect();
    let resolved = resolve_catalog_for_announcement(input, &pre_compact)?;
    if !resolved.enabled {
        return Ok(None);
    }
    let names: Vec<String> = resolved.deferred.iter().cloned().collect();
    let added_names: Vec<String> = names
        .iter()
        .filter(|name| !announced.contains(*name) || !listed.contains(*name))
        .cloned()
        .collect();
    let readded_names: Vec<String> = names
        .iter()
        .filter(|name| !announced.contains(*name) && listed.contains(*name))
        .cloned()
        .collect();
    // deferred 转 alwaysLoad 后工具仍可用：删除对照完整当前作用域目录。
    let available: BTreeSet<&str> = input.tools.iter().map(definition_name).collect();
    let removed_names: Vec<String> = announced
        .iter()
        .filter(|name| !available.contains(name.as_str()))
        .cloned()
        .collect();
    if added_names.is_empty() && removed_names.is_empty() {
        return Ok(None);
    }
    let readded: BTreeSet<&String> = readded_names.iter().collect();
    let listed_names: Vec<&String> = added_names
        .iter()
        .filter(|name| !readded.contains(*name))
        .collect();
    let mut paragraphs: Vec<String> = vec![];
    if !listed_names.is_empty() {
        let notice = if resolved.mode == ResolvedMode::Local {
            LOCAL_ADDED_TOOLS_NOTICE
        } else {
            ADDED_TOOLS_NOTICE
        };
        let body = listed_names
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        paragraphs.push(format!("{notice}\n{body}"));
    }
    // 目录变化只证明当前可用性，不推断 MCP 断连/重连原因。
    if !readded_names.is_empty() {
        let plural = if readded_names.len() == 1 {
            "is"
        } else {
            "are"
        };
        paragraphs.push(format!(
            "{} deferred tool{plural} available again (names announced earlier in this conversation): {}. Load via ToolSearch as before.",
            readded_names.len(),
            summarize_names(&readded_names)
        ));
    }
    if !removed_names.is_empty() {
        paragraphs.push(if removed_names.len() > MAX_REMOVED_NAME_LINES {
            format!(
                "{} deferred tools are no longer available: {}. Do not search for them — ToolSearch will return no match.",
                removed_names.len(),
                summarize_names(&removed_names)
            )
        } else {
            format!(
                "The following deferred tools are no longer available. Do not search for them — ToolSearch will return no match:\n{}",
                removed_names.join("\n")
            )
        });
        paragraphs.push(AMBIENT_CONTEXT_NOTICE.into());
    }
    let announcement = Announcement {
        added_names,
        removed_names,
        readded_names,
    };
    Ok(Some((paragraphs.join("\n\n"), announcement)))
}

/// Node `summarizeToolNames`：MCP 名称按 server 汇总，其余保留原名。
fn summarize_names(names: &[String]) -> String {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for name in names {
        let key = if name.starts_with("mcp__") {
            let server = name.split("__").take(2).collect::<Vec<_>>().join("__");
            format!("{server}__*")
        } else {
            name.clone()
        };
        *counts.entry(key).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(name, count)| {
            if count > 1 {
                format!("{name} ({count})")
            } else {
                name
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ToolSearchCapability;
    use crate::tool_search::{ADDED_TOOLS_NOTICE, Mode, local_description, native_description};
    use crate::tool_search::{Metadata, build_exposure, builtin_metadata};
    use serde_json::{Value, json};

    fn tool(name: &str) -> Value {
        json!({"type":"function","function":{"name":name,"description":"d","parameters":{"type":"object"}}})
    }

    fn catalog() -> Vec<Value> {
        vec![
            tool("Read"),
            tool("ToolSearch"),
            tool("DeferredToolCall"),
            tool("TodoWrite"),
            tool("WebFetch"),
        ]
    }

    fn metadata(name: &str) -> Metadata {
        if name == "mcp__docs__lookup" {
            return Metadata {
                should_defer: true,
                mcp: Some(super::super::McpName {
                    server_name: "docs".into(),
                    tool_name: "lookup".into(),
                }),
                ..Default::default()
            };
        }
        builtin_metadata(name)
    }

    fn input<'a>(
        mode: Mode,
        capability: Option<ToolSearchCapability>,
        tools: &'a [Value],
        messages: &'a [Value],
        compact: &'a [String],
    ) -> ExposureInput<'a> {
        ExposureInput {
            mode,
            capability,
            supports_tool_call: true,
            tools,
            metadata: &metadata,
            messages,
            compact_discovered: compact,
        }
    }

    #[test]
    fn off_exposes_full_catalog_and_hides_controls() {
        let tools = catalog();
        let exposure = build_exposure(&input(Mode::Off, None, &tools, &[], &[])).unwrap();
        let names: Vec<&str> = exposure.tools.iter().map(super::definition_name).collect();
        assert_eq!(names, vec!["Read", "TodoWrite", "WebFetch"]);
        assert_eq!(exposure.mode, ResolvedMode::Off);
        assert_eq!(exposure.reason, "provider_disabled");
        assert!(!exposure.native);
    }

    #[test]
    fn native_exposes_only_discovered_deferred_schemas() {
        let tools = catalog();
        let messages = vec![
            json!({"role":"assistant","content":"","tool_calls":[
                {"id":"c1","type":"function","function":{"name":"ToolSearch","arguments":"{}"}}]}),
            json!({"role":"tool","tool_call_id":"c1","content":[
                {"type":"tool_reference","toolName":"TodoWrite"}]}),
        ];
        let capability = Some(ToolSearchCapability::new(true, true));
        let exposure =
            build_exposure(&input(Mode::Native, capability, &tools, &messages, &[])).unwrap();
        let names: Vec<&str> = exposure.tools.iter().map(super::definition_name).collect();
        assert_eq!(names, vec!["Read", "ToolSearch", "TodoWrite"]);
        assert_eq!(exposure.tools[2]["deferLoading"], true);
        assert!(exposure.native && exposure.enabled);
        assert!(exposure.discovered.contains("TodoWrite"));
        // Native 描述保持上游文案。
        assert_eq!(
            exposure.tools[1]["function"]["description"],
            native_description()
        );
    }

    #[test]
    fn local_exposes_controls_and_promotes_compact_checkpoint() {
        let tools = catalog();
        let compact = ["TodoWrite".to_owned()];
        let exposure = build_exposure(&input(Mode::Local, None, &tools, &[], &compact)).unwrap();
        let names: Vec<&str> = exposure.tools.iter().map(super::definition_name).collect();
        assert_eq!(
            names,
            vec!["Read", "ToolSearch", "DeferredToolCall", "TodoWrite"]
        );
        // 提升后的工具按普通工具发送（无 deferLoading），Local 描述覆盖。
        assert_eq!(exposure.tools[3].get("deferLoading"), None);
        assert_eq!(
            exposure.tools[1]["function"]["description"],
            local_description()
        );
        // 发现集仍保留提升名称（请求投影/公告共用分类）。
        assert!(exposure.pre_compact_discovered.contains("TodoWrite"));
    }

    #[test]
    fn no_deferred_or_missing_controls_fall_back_to_full_catalog() {
        let tools = vec![tool("Read"), tool("ToolSearch")];
        let exposure = build_exposure(&input(Mode::Local, None, &tools, &[], &[])).unwrap();
        assert_eq!(exposure.mode, ResolvedMode::Off);
        assert_eq!(exposure.reason, "no_deferred_tools");
        // 退化到全目录时控制入口仍隐藏（只移除 ToolSearch）。
        assert_eq!(
            exposure
                .tools
                .iter()
                .map(super::definition_name)
                .collect::<Vec<_>>(),
            vec!["Read"]
        );
        let tools = vec![tool("Read"), tool("TodoWrite")];
        let exposure = build_exposure(&input(Mode::Local, None, &tools, &[], &[])).unwrap();
        assert_eq!(exposure.reason, "tool_unavailable");
        assert_eq!(
            exposure
                .tools
                .iter()
                .map(super::definition_name)
                .collect::<Vec<_>>(),
            vec!["Read", "TodoWrite"]
        );
    }

    #[test]
    fn native_without_protocol_support_fails_before_send() {
        let tools = catalog();
        assert_eq!(
            build_exposure(&input(Mode::Native, None, &tools, &[], &[])).unwrap_err(),
            "native_tool_search_unsupported"
        );
    }

    #[test]
    fn announcement_reports_deltas_and_readds() {
        let tools = catalog();
        let capability = Some(ToolSearchCapability::new(true, true));
        let first = build_announcement(&input(Mode::Native, capability, &tools, &[], &[]), &[])
            .unwrap()
            .unwrap();
        assert_eq!(first.1.added_names, vec!["TodoWrite", "WebFetch"]);
        assert!(first.0.contains(ADDED_TOOLS_NOTICE));
        // 已公告且完整列名：不再重复。
        let messages = vec![json!({super::super::ANNOUNCEMENT_KEY: {
            "addedNames":["TodoWrite"],"removedNames":[],"readdedNames":[]}})];
        let second = build_announcement(
            &input(Mode::Native, capability, &tools, &messages, &[]),
            &[],
        )
        .unwrap()
        .unwrap();
        assert_eq!(second.1.added_names, vec!["WebFetch"]);
        assert!(second.1.readded_names.is_empty());
        // 恢复公告：曾列名但已移除。
        let messages = vec![
            json!({super::super::ANNOUNCEMENT_KEY: {
                "addedNames":["TodoWrite"],"removedNames":[],"readdedNames":[]}}),
            json!({super::super::ANNOUNCEMENT_KEY: {
                "addedNames":[],"removedNames":["TodoWrite"],"readdedNames":[]}}),
        ];
        let third = build_announcement(
            &input(Mode::Native, capability, &tools, &messages, &[]),
            &[],
        )
        .unwrap()
        .unwrap();
        assert_eq!(third.1.readded_names, vec!["TodoWrite"]);
        assert!(third.1.added_names.contains(&"TodoWrite".to_owned()));
        assert!(third.0.contains("available again"));
        // 没有变化不提交。
        let messages = vec![json!({super::super::ANNOUNCEMENT_KEY: {
            "addedNames":["TodoWrite","WebFetch"],"removedNames":[],"readdedNames":[]}})];
        assert!(
            build_announcement(
                &input(Mode::Native, capability, &tools, &messages, &[]),
                &[]
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn off_mode_never_announces() {
        let tools = catalog();
        assert!(
            build_announcement(&input(Mode::Off, None, &tools, &[], &[]), &[])
                .unwrap()
                .is_none()
        );
    }
}
