//! 上游 3.18.2 F12：会话能力标签（`x-zcode-session-features`）。
//!
//! 标签回答「本会话用过哪些能力」，只增不减：compact、rewind、冷恢复都不撤销。
//! owner 是 Engine 的 `Session.session_features`；模型请求只读取快照，词表外的标签直接忽略。
use serde_json::{Value, json};

pub const BROWSER_USE: &str = "browser_use";
pub const COMPUTER_USE: &str = "computer_use";
pub const TOOL_SEARCH_CALLED: &str = "tool_search_called";
pub const TOOL_SEARCH_LOCAL: &str = "tool_search_local";
pub const TOOL_SEARCH_NATIVE: &str = "tool_search_native";
pub const WORKFLOW_AUTO: &str = "workflow_auto";
pub const WORKFLOW_AUTO_ATTEMPT: &str = "workflow_auto_attempt";
pub const WORKFLOW_CMD: &str = "workflow_cmd";

/// 词表（与上游 `ModelRequestSessionFeature` 相同，只追加）。
pub const ALL: [&str; 8] = [
    BROWSER_USE,
    COMPUTER_USE,
    TOOL_SEARCH_CALLED,
    TOOL_SEARCH_LOCAL,
    TOOL_SEARCH_NATIVE,
    WORKFLOW_AUTO,
    WORKFLOW_AUTO_ATTEMPT,
    WORKFLOW_CMD,
];

/// 受控请求头：由调用上下文独占，provider 静态配置的同名头必须剔除。
pub const HEADER: &str = "x-zcode-session-features";
/// session_entry 类型（上游 `SESSION_ENTRY_SESSION_FEATURES`）。
pub const ENTRY: &str = "runtime/session_features";
const SEPARATOR: &str = ",";
const HEADER_MAX_LENGTH: usize = 256;
const VALUE_MAX_LENGTH: usize = 64;
/// `mcp__node_repl__js` 结果里的可信来源键（node-repl-host 写入）。
const NODE_REPL_TOOL_NAME: &str = "mcp__node_repl__js";
const NODE_REPL_BROWSER_USE_KEY: &str = "zcode/nodeReplBrowserUse";
const NODE_REPL_COMPUTER_USE_KEY: &str = "zcode/nodeReplComputerUse";

pub fn is_feature(value: &str) -> bool {
    ALL.contains(&value)
}

/// 上游 `^[a-z0-9_]{1,64}$`：不合法时整个头省略，避免 HTTP 头校验阻断请求。
fn valid_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= VALUE_MAX_LENGTH
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// 出站头值：去重、字典序、任一非法或超长则返回 `None`。
pub fn header_value<'a>(features: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut unique: Vec<&str> = features.into_iter().collect();
    unique.sort_unstable();
    unique.dedup();
    if unique.is_empty() || !unique.iter().all(|f| valid_value(f)) {
        return None;
    }
    let value = unique.join(SEPARATOR);
    (value.len() <= HEADER_MAX_LENGTH).then_some(value)
}

/// session_entry 的 data；features 按字典序。
pub fn entry_data<'a>(features: impl IntoIterator<Item = &'a str>) -> Value {
    let mut unique: Vec<&str> = features.into_iter().collect();
    unique.sort_unstable();
    unique.dedup();
    json!({"features": unique})
}

/// entry 读取：词表外标签（更新的版本降级回来）直接忽略。
pub fn parse_entry(data: &Value) -> Vec<String> {
    data["features"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| is_feature(value))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// 请求准备后按 ToolSearch **实际生效模式**打点（本次请求就带上）。
pub fn from_tool_search_exposure(enabled: bool, mode: &str) -> Option<&'static str> {
    if !enabled {
        return None;
    }
    match mode {
        "native" => Some(TOOL_SEARCH_NATIVE),
        "local" => Some(TOOL_SEARCH_LOCAL),
        _ => None,
    }
}

/// 一次结算结果对应的标签：只读结果，不改结算流程。
pub fn from_tool_result(name: &str, failed: bool, output: &Value) -> Vec<&'static str> {
    // local 模式下模型看到的名字是 LocalToolSearch，执行器换成规范名。
    if matches!(
        name,
        crate::tool_search::TOOL_SEARCH_NAME | "LocalToolSearch"
    ) && !failed
    {
        return vec![TOOL_SEARCH_CALLED];
    }
    // BUA/CUA 的口径是「真实尝试」，不看成功；只认 node-repl-host 写的可信 key。
    if name == NODE_REPL_TOOL_NAME {
        let meta = &output["_meta"];
        let mut features = Vec::new();
        if meta[NODE_REPL_BROWSER_USE_KEY] == true {
            features.push(BROWSER_USE);
        }
        if meta[NODE_REPL_COMPUTER_USE_KEY] == true {
            features.push(COMPUTER_USE);
        }
        return features;
    }
    Vec::new()
}

/// 冷恢复/ fork：从持久消息推导（entry 缺失或落后时使用）。
/// 推不出 native/local、BUA、CUA —— 它们只靠 entry；workflow_auto/workflow_cmd 需要真实命令
/// 或 display 元数据，本仓没有对应 workflow 调用路径，不从用户原文猜测。
pub fn from_persisted_messages(messages: &[Value]) -> Vec<&'static str> {
    let mut features = Vec::new();
    for message in messages {
        if let Some("tool") = message["role"].as_str() {
            let name = message["toolName"].as_str().unwrap_or("");
            if matches!(
                name,
                crate::tool_search::TOOL_SEARCH_NAME | "LocalToolSearch"
            ) && message["isError"] != true
            {
                features.push(TOOL_SEARCH_CALLED);
            }
        }
    }
    features
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_is_sorted_deduplicated_and_validated() {
        assert_eq!(
            header_value([TOOL_SEARCH_CALLED, BROWSER_USE, TOOL_SEARCH_CALLED]).as_deref(),
            Some("browser_use,tool_search_called")
        );
        assert!(header_value([]).is_none());
        assert!(header_value(["Bad Label"]).is_none());
        assert!(header_value([&"a".repeat(65)[..]]).is_none());
        // 总长超限整头省略：8 个合法标签最长 154 字节，这里构造 324 字节验证分支。
        let long: Vec<String> = (0..5).map(|i| format!("{i}{}", "b".repeat(63))).collect();
        assert!(header_value(long.iter().map(String::as_str)).is_none());
    }

    #[test]
    fn the_entry_shape_filters_unknown_values() {
        let data = entry_data([TOOL_SEARCH_NATIVE, BROWSER_USE]);
        assert_eq!(
            data,
            json!({"features": ["browser_use", "tool_search_native"]})
        );
        assert_eq!(
            parse_entry(&json!({"features": ["browser_use", "from_the_future", 3]})),
            vec![BROWSER_USE.to_string()]
        );
        assert!(parse_entry(&json!({})).is_empty());
    }

    #[test]
    fn exposure_and_results_map_to_the_documented_features() {
        assert_eq!(from_tool_search_exposure(false, "native"), None);
        assert_eq!(
            from_tool_search_exposure(true, "native"),
            Some(TOOL_SEARCH_NATIVE)
        );
        assert_eq!(
            from_tool_search_exposure(true, "local"),
            Some(TOOL_SEARCH_LOCAL)
        );
        assert_eq!(from_tool_search_exposure(true, "off"), None);
        assert_eq!(
            from_tool_result("LocalToolSearch", false, &Value::Null),
            vec![TOOL_SEARCH_CALLED]
        );
        assert!(from_tool_result("ToolSearch", true, &Value::Null).is_empty());
        // token 估计/失败标记无关：只认可信 key，且不看 isError。
        assert_eq!(
            from_tool_result(
                NODE_REPL_TOOL_NAME,
                true,
                &json!({"_meta": {"zcode/nodeReplBrowserUse": true}})
            ),
            vec![BROWSER_USE]
        );
        assert_eq!(
            from_tool_result(
                NODE_REPL_TOOL_NAME,
                false,
                &json!({"_meta": {"zcode/nodeReplComputerUse": true}})
            ),
            vec![COMPUTER_USE]
        );
    }

    #[test]
    fn persisted_history_only_derives_what_it_can_prove() {
        let messages = vec![
            json!({"role": "user", "content": " /workflow ship it"}),
            json!({"role": "tool", "toolName": "ToolSearch", "isError": false}),
            json!({"role": "tool", "toolName": "ToolSearch", "isError": true}),
            json!({"role": "tool", "toolName": "Bash", "isError": false}),
        ];
        assert_eq!(from_persisted_messages(&messages), vec![TOOL_SEARCH_CALLED]);
    }
}
