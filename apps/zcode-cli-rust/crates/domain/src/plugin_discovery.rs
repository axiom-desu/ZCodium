//! 插件发现（`SearchPlugins`/`SuggestPluginInstall`）的领域事实：工具名、严格输入与游标分页入口。
//!
//! 候选目录、安装/启用与激活事实都由既有插件 owner 提供（`crates/tools` 适配器）；
//! 这里只保留模型可见的意图与纯规则。
use serde_json::{Value, json};

pub const SEARCH: &str = "SearchPlugins";
pub const SUGGEST: &str = "SuggestPluginInstall";
/// 模型一次最多看到的候选数（Node `PLUGIN_DISCOVERY_PAGE_SIZE`）。
pub const PAGE_SIZE: usize = 10;
const TEXT_MAX: usize = 2_000;

/// 端口/目录缺席或子代理执行面：显式不可用，不造空目录。
pub const ERROR_UNAVAILABLE: &str = "Plugin discovery is unavailable in this client.";
pub const ERROR_INPUT_OBJECT: &str = "Plugin discovery input must be an object";

pub fn tools() -> [&'static str; 2] {
    [SEARCH, SUGGEST]
}

pub fn is_tool(name: &str) -> bool {
    tools().contains(&name)
}

pub struct SearchInput {
    pub query: String,
    pub cursor: Option<String>,
}

pub struct SuggestInput {
    pub plugin_id: String,
    pub reason: String,
    pub reconsider: bool,
}

fn object(args: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    args.as_object()
        .ok_or_else(|| ERROR_INPUT_OBJECT.to_owned())
}

/// 严格对象：未知键是参数错误（Node `z.strictObject`），不静默丢弃。
fn unknown_key(args: &serde_json::Map<String, Value>, allowed: &[&str]) -> Option<String> {
    args.keys()
        .find(|key| !allowed.contains(&key.as_str()))
        .map(|key| format!("Unrecognized key(s) in plugin discovery input: '{key}'."))
}

fn text(args: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= TEXT_MAX)
        .ok_or_else(|| format!("{key}: required (1-{TEXT_MAX} characters)"))?;
    Ok(value.to_owned())
}

pub fn parse_search(args: &Value) -> Result<SearchInput, String> {
    let args = object(args)?;
    if let Some(error) = unknown_key(args, &["query", "cursor"]) {
        return Err(error);
    }
    let query = text(args, "query")?;
    let cursor = match args.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(cursor)) if cursor.chars().count() <= TEXT_MAX => Some(cursor.clone()),
        Some(_) => return Err("cursor: must be a string of at most 2000 characters".into()),
    };
    Ok(SearchInput { query, cursor })
}

pub fn parse_suggest(args: &Value) -> Result<SuggestInput, String> {
    let args = object(args)?;
    if let Some(error) = unknown_key(args, &["pluginId", "reason", "reconsider"]) {
        return Err(error);
    }
    let plugin_id = text(args, "pluginId")?;
    let reason = text(args, "reason")?;
    let reconsider = match args.get("reconsider") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("reconsider: must be a boolean".into()),
    };
    Ok(SuggestInput {
        plugin_id,
        reason,
        reconsider,
    })
}

/// `SuggestPluginInstall` 的固定结论形状（与 Node schema 同键）。
pub fn suggestion(plugin_id: &str, status: &str, message: &str, activation: Option<&str>) -> Value {
    let mut output = json!({"pluginId":plugin_id,"status":status,"message":message});
    if let Some(activation) = activation {
        output["activation"] = Value::String(activation.into());
    }
    output
}

#[cfg(test)]
#[path = "plugin_discovery_tests.rs"]
mod tests;
