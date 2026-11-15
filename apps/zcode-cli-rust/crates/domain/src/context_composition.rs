//! 上游 3.18.2 F4：context composition 分类（11 个细类别）。
//!
//! 唯一计算点：主轮次模型请求准备之后，用**真实请求**（前缀、ToolSearch 曝光后的工具、
//! 投影后的 messages）分类。Rust 没有上游的 runtime message entry/section 元数据，
//! 归因只看请求里的消息形态，这一点写在 `.agents/specs/upstream-3.18-rust-parity-r3.md`。
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const CATEGORY_IDS: [&str; 11] = [
    "system_prompt",
    "meta_user_context",
    "skills",
    "tool_prompt",
    "system_tool_schemas",
    "mcp_tool_schemas",
    "app_tool_schemas",
    "deferred_tool_schemas",
    "reminders",
    "compact_summary",
    "messages",
];
/// 每个类别最多返回的条目数。
pub const MAX_ITEMS: usize = 50;
/// 条目名最长字符数（Unicode 标量近似上游的 UTF-16 截断）。
pub const MAX_ITEM_NAME: usize = 200;
/// 指令公告与 context 前缀共用的用户消息来源标记。
const INSTRUCTIONS_KEY: &str = "_zcode_instructions";
const REMINDER_PREFIX: &str = "<system-reminder>";
const SUMMARY_PREFIX: &str = "<summary";
const MCP_PREFIX: &str = "mcp__";
const APP_PREFIX: &str = "app__";

#[derive(Default)]
struct Accumulator {
    chars: usize,
    tokens: usize,
    items: BTreeMap<String, (usize, usize)>,
}

impl Accumulator {
    fn add(&mut self, name: &str, (chars, tokens): (usize, usize)) {
        self.chars += chars;
        self.tokens += tokens;
        let item = self.items.entry(name.to_owned()).or_insert((0, 0));
        item.0 += chars;
        item.1 += tokens;
    }
}

/// 一次请求 → 线格式 `categories`（0 值类别省略，条目按 token 降序、≤50 条）。
pub fn classify(messages: &[Value], tools: &[Value]) -> Value {
    let mut categories: Vec<Accumulator> = CATEGORY_IDS
        .iter()
        .map(|_| Accumulator::default())
        .collect();
    let index: BTreeMap<&str, usize> = CATEGORY_IDS
        .iter()
        .enumerate()
        .map(|(position, id)| (*id, position))
        .collect();
    let mut leading = true;
    for message in messages {
        let role = message["role"].as_str().unwrap_or("");
        let category = match role {
            "system" if leading => "system_prompt",
            // 前缀里的日期块是 meta-user；其余 `<system-reminder>` 都是运行时提醒。
            _ if leading && role == "user" => "meta_user_context",
            _ => "messages",
        };
        if role != "system" {
            leading = false;
        }
        let id = reminder_category(message).unwrap_or(category);
        let name = item_name(id, role, message);
        let text = message_text(message);
        categories[index[id]].add(&name, size(&text));
    }
    for tool in tools {
        let (id, text) = tool_category(tool);
        categories[index[id]].add(
            tool["function"]["name"].as_str().unwrap_or("tool"),
            size(&text),
        );
    }
    let out = CATEGORY_IDS
        .iter()
        .zip(categories)
        .filter(|(_, accumulator)| accumulator.tokens > 0)
        .map(|(id, accumulator)| {
            let mut items: Vec<(String, usize, usize)> = accumulator
                .items
                .into_iter()
                .map(|(name, (chars, tokens))| (name, chars, tokens))
                .filter(|(name, _, _)| !name.is_empty())
                .collect();
            // token 降序；同 token 按 chars 降序、名字升序，输出与集合遍历无关。
            items.sort_by(|left, right| {
                right
                    .2
                    .cmp(&left.2)
                    .then(right.1.cmp(&left.1))
                    .then(left.0.cmp(&right.0))
            });
            items.truncate(MAX_ITEMS);
            let mut category =
                json!({"id": id, "tokens": accumulator.tokens, "chars": accumulator.chars});
            if !items.is_empty() {
                category["items"] = items
                    .into_iter()
                    .map(|(name, _, tokens)| json!({"name": truncate(&name), "tokens": tokens}))
                    .collect();
            }
            category
        })
        .collect::<Vec<_>>();
    Value::Array(out)
}

/// 提醒/摘要/指令公告的形状判定：优先级与上游 `entryCategory` 一致。
fn reminder_category(message: &Value) -> Option<&'static str> {
    if message[INSTRUCTIONS_KEY].is_object() {
        return Some("meta_user_context");
    }
    let text = message["content"].as_str().unwrap_or("");
    if text.trim_start().starts_with(SUMMARY_PREFIX) {
        return Some("compact_summary");
    }
    if text.trim_start().starts_with(REMINDER_PREFIX) {
        return Some("reminders");
    }
    None
}

fn item_name(category: &'static str, role: &str, message: &Value) -> String {
    match category {
        "system_prompt" => "system_prompt".into(),
        "meta_user_context" => "context_prefix".into(),
        "compact_summary" => "compact_summary".into(),
        "reminders" => {
            // Rust 的提醒没有 metadata.source；用指令/上下文/技能三类真实来源收口。
            if message[INSTRUCTIONS_KEY].is_object() {
                "context_prefix".into()
            } else {
                "system_reminder".into()
            }
        }
        _ => role.to_owned(),
    }
}

/// 工具 → 细类别：延迟加载只计名字与描述，MCP/app 按真实前缀归类。
fn tool_category(tool: &Value) -> (&'static str, String) {
    let mcp = tool["function"]["name"]
        .as_str()
        .is_some_and(|name| name.starts_with(MCP_PREFIX));
    let name = tool["function"]["name"].as_str().unwrap_or("");
    let function = &tool["function"];
    if function["deferLoading"] == true {
        return (
            "deferred_tool_schemas",
            serde_json::to_string(&json!({
                "name": name,
                "description": function["description"],
            }))
            .unwrap_or_default(),
        );
    }
    let text = serde_json::to_string(function).unwrap_or_default();
    if mcp {
        ("mcp_tool_schemas", text)
    } else if name.starts_with(APP_PREFIX) {
        ("app_tool_schemas", text)
    } else {
        ("system_tool_schemas", text)
    }
}

fn message_text(message: &Value) -> String {
    let mut text = match &message["content"] {
        Value::String(value) => value.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    if let Some(calls) = message["tool_calls"].as_array() {
        text.push_str(&serde_json::to_string(calls).unwrap_or_default());
    }
    text
}

/// 与既有估算器同一口径，保证 composition 与用量圆环可比。
fn size(text: &str) -> (usize, usize) {
    (
        text.chars().count(),
        crate::context::estimate(&[json!({"content": text})]),
    )
}

fn truncate(name: &str) -> String {
    if name.chars().count() <= MAX_ITEM_NAME {
        return name.to_owned();
    }
    name.chars().take(MAX_ITEM_NAME).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_is_split_into_the_documented_categories() {
        let messages = vec![
            json!({"role": "system", "content": "s0"}),
            json!({"role": "system", "content": "s1"}),
            json!({"role": "system", "content": "s2"}),
            json!({"role": "user", "content": "<system-reminder>date</system-reminder>"}),
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": "yo"}),
            json!({"role": "tool", "content": "result"}),
            json!({"role": "user", "content": "<system-reminder>env</system-reminder>"}),
            json!({"role": "user", "content": "done", "_zcode_instructions": {"files": []}}),
        ];
        let tools = vec![
            json!({"type": "function", "function": {"name": "Read", "description": "read"}}),
            json!({"type": "function", "function": {"name": "mcp__x__y", "description": "m"}}),
            json!({"type": "function", "function": {"name": "app__page", "description": "a"}}),
            json!({"type": "function", "function": {"name": "Later", "description": "d", "deferLoading": true}}),
        ];
        let categories = classify(&messages, &tools);
        let ids: Vec<&str> = categories
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![
                "system_prompt",
                "meta_user_context",
                "system_tool_schemas",
                "mcp_tool_schemas",
                "app_tool_schemas",
                "deferred_tool_schemas",
                "reminders",
                "messages",
            ]
        );
        for category in categories.as_array().unwrap() {
            assert!(category["tokens"].as_u64().unwrap() > 0);
            assert!(category["chars"].as_u64().unwrap() > 0);
        }
        let messages = categories
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == "messages")
            .unwrap();
        let names: Vec<&str> = messages["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["name"].as_str().unwrap())
            .collect();
        // 条目按名字聚合（与上游 `itemName = message.role` 相同），token 降序。
        assert_eq!(names, vec!["tool", "assistant", "user"]);
    }

    #[test]
    fn a_compact_summary_and_item_limits_are_applied() {
        let messages = vec![json!({"role": "user", "content": "<summary>so far</summary>"})];
        let tools: Vec<Value> = (0..60)
            .map(|index| {
                json!({"type": "function",
                    "function": {"name": format!("t{index}"), "description": format!("d{index}")}})
            })
            .collect();
        let categories = classify(&messages, &tools);
        let summary = categories
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == "compact_summary")
            .expect("the summary message is its own category");
        assert_eq!(summary["items"][0]["name"], "compact_summary");
        let schemas = categories
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == "system_tool_schemas")
            .unwrap();
        assert_eq!(schemas["items"].as_array().unwrap().len(), MAX_ITEMS);
        // 条目名按名字聚合：同角色的多条消息只占一个条目。
        let messages = categories
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == "messages");
        assert!(messages.is_none());
        let long = "x".repeat(MAX_ITEM_NAME + 20);
        assert_eq!(truncate(&long).chars().count(), MAX_ITEM_NAME);
    }
}
