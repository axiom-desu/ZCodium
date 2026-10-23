//! Node `contracts/src/tools/tool-search.ts` 与 `core/src/tool/search/*` 的纯领域移植。
//! 只做请求暴露、搜索与投影计算：不读写历史、不发事件、不持久化。
mod announce;
mod discovery;
mod exposure;
mod projection;
mod search;

pub use announce::build_announcement;
pub use discovery::{
    Announcement, announcement_delta, collect_discovered, deferred_input, model_content,
    wrapper_target,
};
pub use exposure::{
    ADDED_TOOLS_NOTICE, Exposure, ExposureInput, LOCAL_ADDED_TOOLS_NOTICE, build_exposure,
};
pub use projection::project_messages;
pub use search::search_tools;

use crate::model::ToolSearchCapability;
use serde_json::Value;
use std::sync::LazyLock;

pub const TOOL_SEARCH_NAME: &str = "ToolSearch";
pub const DEFERRED_TOOL_CALL_NAME: &str = "DeferredToolCall";
pub const DEFAULT_RESULTS: usize = 5;
/// 内部包装标记（Node `ModelCallWrapperSchema`）。
pub const WRAPPER_KEY: &str = "_zcode_model_call_wrapper";
/// 公告增量 metadata 在消息上的内部键（Node `metadata.toolSearchAnnouncement`）。
pub const ANNOUNCEMENT_KEY: &str = "_zcode_tool_search_announcement";
pub const ANNOUNCEMENT_SOURCE: &str = "tool_search_announcement";

/// 启动偏好四值（CLI `--toolsearch-mode`）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Native,
    Local,
    #[default]
    Off,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "native" => Some(Self::Native),
            "local" => Some(Self::Local),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Native => "native",
            Self::Local => "local",
            Self::Off => "off",
        }
    }
}

/// 已解析的实际模式（没有 `auto`）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ResolvedMode {
    Native,
    Local,
    #[default]
    Off,
}

impl ResolvedMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Local => "local",
            Self::Off => "off",
        }
    }
}

/// Node `resolveToolSearchMode`：caps 来自真实非秘密配置，`tool_calls` 来自 model properties。
/// 显式 native/local 的能力不满足时返回错误（发送前失败），auto 退化为可用模式。
pub fn resolve_mode(
    mode: Mode,
    capability: Option<ToolSearchCapability>,
    tool_calls: bool,
) -> Result<ResolvedMode, &'static str> {
    let capability = capability.unwrap_or_default();
    match mode {
        Mode::Off => Ok(ResolvedMode::Off),
        Mode::Native => {
            if capability.protocol_supported {
                Ok(ResolvedMode::Native)
            } else {
                Err("native_tool_search_unsupported")
            }
        }
        Mode::Auto => {
            if capability.protocol_supported && capability.default_enabled {
                Ok(ResolvedMode::Native)
            } else if tool_calls {
                Ok(ResolvedMode::Local)
            } else {
                Ok(ResolvedMode::Off)
            }
        }
        Mode::Local => {
            if tool_calls {
                Ok(ResolvedMode::Local)
            } else {
                Err("local_tool_search_requires_tool_calls")
            }
        }
    }
}

/// MCP 身份的短名匹配材料（Node `ToolSearchCandidate.mcp`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpName {
    pub server_name: String,
    pub tool_name: String,
}

/// 一个候选工具的搜索/分类事实。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Candidate {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub search_hint: Option<String>,
    pub mcp: Option<McpName>,
    pub deferred: bool,
    pub provider_native: bool,
}

/// 工具注册元数据（Node `ToolMetadata` 的相关字段）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Metadata {
    pub should_defer: bool,
    pub always_load: bool,
    pub search_hint: Option<String>,
    pub provider_native: bool,
    pub mcp: Option<McpName>,
}

/// Node `isDeferredTool`：控制入口、provider 原生、alwaysLoad 与显式 shouldDefer/MCP 的分类。
pub fn is_deferred(name: &str, metadata: &Metadata) -> bool {
    name != TOOL_SEARCH_NAME
        && name != DEFERRED_TOOL_CALL_NAME
        && !metadata.provider_native
        && !metadata.always_load
        && (metadata.should_defer || metadata.mcp.is_some())
}

/// 生成资产：来自真实 TS 注册 entry 的固定文案与 `builtInTools` metadata。
static DESCRIPTIONS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../tool_search_descriptions.json"))
        .expect("generated tool search descriptions")
});
static BUILTIN_METADATA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../tool_search_metadata.json"))
        .expect("generated builtin tool metadata")
});

pub fn native_description() -> &'static str {
    DESCRIPTIONS["ToolSearch"]["native"]
        .as_str()
        .unwrap_or_default()
}

pub fn local_description() -> &'static str {
    DESCRIPTIONS["ToolSearch"]["local"]
        .as_str()
        .unwrap_or_default()
}

pub fn deferred_description() -> &'static str {
    DESCRIPTIONS["DeferredToolCall"]["native"]
        .as_str()
        .unwrap_or_default()
}

/// 内置工具的常驻/deferred/searchHint 事实（生成自真实 `builtInTools`）。
pub fn builtin_metadata(name: &str) -> Metadata {
    let entry = &BUILTIN_METADATA[name];
    Metadata {
        should_defer: entry["shouldDefer"] == true,
        always_load: entry["alwaysLoad"] == true,
        search_hint: entry["searchHint"].as_str().map(str::to_owned),
        provider_native: false,
        mcp: None,
    }
}

/// 内置工具并发安全事实（生成自真实 `builtInTools`）。
pub fn builtin_concurrent_safe(name: &str) -> bool {
    BUILTIN_METADATA[name]["concurrentSafe"] == true
}

/// 工具定义的名字。
pub fn definition_name(definition: &Value) -> &str {
    definition["function"]["name"].as_str().unwrap_or("")
}

/// 从模型可见定义构造候选（描述使用最终 model contract description）。
pub fn candidate(definition: &Value, metadata: &Metadata) -> Candidate {
    let name = definition_name(definition).to_owned();
    Candidate {
        deferred: is_deferred(&name, metadata),
        aliases: vec![],
        description: definition["function"]["description"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        search_hint: metadata.search_hint.clone(),
        mcp: metadata.mcp.clone(),
        provider_native: metadata.provider_native,
        name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_follow_capability_and_tool_calls() {
        let none = None;
        let anthropic = Some(ToolSearchCapability::new(true, false));
        let plan = Some(ToolSearchCapability::new(true, true));
        let openai = Some(ToolSearchCapability::new(false, false));
        assert_eq!(
            resolve_mode(Mode::Off, anthropic, true),
            Ok(ResolvedMode::Off)
        );
        assert_eq!(
            resolve_mode(Mode::Native, none, true),
            Err("native_tool_search_unsupported")
        );
        assert_eq!(
            resolve_mode(Mode::Native, anthropic, true),
            Ok(ResolvedMode::Native)
        );
        assert_eq!(
            resolve_mode(Mode::Auto, anthropic, true),
            Ok(ResolvedMode::Local)
        );
        assert_eq!(
            resolve_mode(Mode::Auto, plan, false),
            Ok(ResolvedMode::Native)
        );
        assert_eq!(
            resolve_mode(Mode::Auto, openai, true),
            Ok(ResolvedMode::Local)
        );
        assert_eq!(resolve_mode(Mode::Auto, none, false), Ok(ResolvedMode::Off));
        assert_eq!(
            resolve_mode(Mode::Local, none, false),
            Err("local_tool_search_requires_tool_calls")
        );
        assert_eq!(Mode::parse("AUTO"), None);
        assert_eq!(Mode::parse("auto"), Some(Mode::Auto));
        assert_eq!(Mode::default(), Mode::Off);
    }

    #[test]
    fn deferred_classification_keeps_resident_and_controls() {
        assert!(!is_deferred("Read", &builtin_metadata("Read")));
        assert!(!is_deferred(TOOL_SEARCH_NAME, &Metadata::default()));
        assert!(!is_deferred(DEFERRED_TOOL_CALL_NAME, &Metadata::default()));
        assert!(is_deferred("WebFetch", &builtin_metadata("WebFetch")));
        assert!(is_deferred("TodoRead", &builtin_metadata("TodoRead")));
        // alwaysLoad 与 provider 原生不 deferred。
        let mut meta = builtin_metadata("WebFetch");
        meta.always_load = true;
        assert!(!is_deferred("WebFetch", &meta));
        meta = builtin_metadata("WebFetch");
        meta.provider_native = true;
        assert!(!is_deferred("WebFetch", &meta));
        assert_eq!(
            builtin_metadata("WebFetch").search_hint.as_deref(),
            Some("fetch and extract content from a URL")
        );
    }
}
