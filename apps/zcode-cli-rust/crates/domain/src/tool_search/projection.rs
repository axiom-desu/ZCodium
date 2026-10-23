//! Node `core/src/tool/search/history.ts` 的引用投影 + `local-projection.ts` 定义渲染。
//! 只派生请求内容：不写主历史、不保存 schema 快照。
use super::discovery::tool_reference_name;
use super::{DEFERRED_TOOL_CALL_NAME, ResolvedMode, TOOL_SEARCH_NAME, WRAPPER_KEY};
use crate::node_history::reminders;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub struct Projection {
    pub messages: Vec<Value>,
    pub loaded_call_ids: BTreeSet<String>,
}

fn definition_text(definition: &Value) -> String {
    let payload = json!({
        "description": definition["function"]["description"].as_str().unwrap_or(""),
        "name": definition["function"]["name"],
        "parameters": definition["function"]["parameters"],
    });
    format!("<function>{payload}</function>")
}

/// 提醒名单按首次出现顺序去重（Node 用 `Set` 收集）。
fn push_unique(names: &mut Vec<String>, name: &str) {
    if !names.iter().any(|existing| existing == name) {
        names.push(name.to_owned());
    }
}

fn functions_block(definitions: &[String]) -> Value {
    json!({"type": "text", "text": format!("<functions>\n{}\n</functions>", definitions.join("\n"))})
}

fn reminder_text(body: &str) -> Value {
    json!({"type": "text", "text": reminders::wrap("tool_result_warning", body)})
}

fn loaded_reminder(names: &[String]) -> Value {
    let action = if names.len() == 1 {
        "Call it now"
    } else {
        "Call them now"
    };
    reminder_text(&format!(
        "Loaded: {}. {action} with {} {{\"name\":\"<tool name>\",\"input\":{{...}}}}, using the exact tool name and filling input according to its schema above. No additional ToolSearch is needed before calling these tools.",
        names.join(", "),
        DEFERRED_TOOL_CALL_NAME
    ))
}

fn already_loaded_reminder(names: &[String]) -> Value {
    reminder_text(&format!(
        "Tool definitions already available in this conversation: {}. Use {} with {{name, input}} to execute these tools. Searching again does not execute them.",
        names.join(", "),
        DEFERRED_TOOL_CALL_NAME
    ))
}

/// Node `toModelToolCall`：内部目标调用在模型协议出口还原为包装调用。
fn rewrap_call(call: &Value) -> Value {
    let Some(wrapper) = call.get(WRAPPER_KEY).and_then(Value::as_str) else {
        return call.clone();
    };
    let input = json!({
        "name": call["function"]["name"],
        "input": serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap_or("{}"))
            .unwrap_or(Value::Null),
    });
    let mut out = json!({"id": call["id"], "type": call["type"],
        "function": {"name": wrapper, "arguments": crate::js_json::stringify(&input)}});
    if call.get("index").is_some() {
        out["index"] = call["index"].clone();
    }
    out
}

fn rewrap_message(message: &Value) -> Value {
    let Some(calls) = message["tool_calls"].as_array() else {
        return message.clone();
    };
    if !calls.iter().any(|call| call.get(WRAPPER_KEY).is_some()) {
        return message.clone();
    }
    let mut out = message.clone();
    out["tool_calls"] = calls.iter().map(rewrap_call).collect::<Vec<_>>().into();
    out
}

/// Node `projectToolReferences`：按模式过滤/展开引用块，并还原包装调用。
pub fn project_messages(
    messages: &[Value],
    mode: ResolvedMode,
    tools: &[Value],
    deferred: &BTreeSet<String>,
) -> Projection {
    let catalog: Option<BTreeMap<&str, &Value>> = (mode != ResolvedMode::Off).then(|| {
        tools
            .iter()
            .map(|tool| (tool["function"]["name"].as_str().unwrap_or(""), tool))
            .collect()
    });
    let local = mode == ResolvedMode::Local;
    // 同批结果尚未被模型看到：直到下一条 assistant 才合入已交付集合。
    let mut visible: BTreeSet<String> = BTreeSet::new();
    let mut pending: BTreeSet<String> = BTreeSet::new();
    let mut projected = Vec::with_capacity(messages.len());
    let mut loaded_call_ids = BTreeSet::new();
    for message in messages {
        if local && message["role"] == "assistant" {
            visible.extend(std::mem::take(&mut pending));
        }
        // Node 在按 role 分流之前就隐藏公告：Off 冷恢复的会话不能再读到旧公告。
        if mode == ResolvedMode::Off && message.get(super::ANNOUNCEMENT_KEY).is_some() {
            continue;
        }
        if message["role"] == "assistant" {
            projected.push(rewrap_message(message));
            continue;
        }
        if message["role"] != "tool" {
            projected.push(message.clone());
            continue;
        }
        let Some(original) = message["content"].as_array() else {
            projected.push(message.clone());
            continue;
        };
        let call_id = message["tool_call_id"].as_str().unwrap_or("");
        let successful_search = !call_id.is_empty()
            && message["_zcode_tool_failed"] != true
            && is_search_call(messages, call_id);
        let mut content: Option<Vec<Value>> = None;
        // 成功 Native 搜索投影后仍有有效引用时，才在结果批次外派生提示。
        let mut native_valid = false;
        let mut definitions: Vec<String> = vec![];
        let mut already_loaded: Vec<String> = vec![];
        let mut newly_loaded: Vec<String> = vec![];
        for (index, block) in original.iter().enumerate() {
            let Some(name) = tool_reference_name(block) else {
                if let Some(content) = content.as_mut() {
                    if !definitions.is_empty() {
                        content.push(functions_block(&definitions));
                        definitions.clear();
                    }
                    content.push(block.clone());
                }
                continue;
            };
            let tool = catalog.as_ref().and_then(|map| map.get(name).copied());
            if content.is_none() && tool.is_some() && !local {
                // 有效 Native 引用直接共享原历史。
                native_valid = true;
                continue;
            }
            if content.is_none() {
                // 仅在引用确实被移除/展开时复制。
                content = Some(original[..index].to_vec());
            }
            if let Some(tool) = tool {
                if local {
                    if successful_search && deferred.contains(name) && visible.contains(name) {
                        push_unique(&mut already_loaded, name);
                    } else {
                        definitions.push(definition_text(tool));
                        // 常驻及 compact 提升工具仍直接调用，不混入包装调用首搜指引。
                        if successful_search && deferred.contains(name) {
                            push_unique(&mut newly_loaded, name);
                        }
                    }
                    if successful_search {
                        pending.insert(name.to_owned());
                    }
                } else {
                    // Native：前序文本/失效引用已复制内容时，有效引用仍须原样保留。
                    native_valid = true;
                    if let Some(content) = content.as_mut() {
                        content.push(block.clone());
                    }
                }
            }
        }
        if successful_search && native_valid {
            loaded_call_ids.insert(call_id.to_owned());
        }
        let Some(mut content) = content.or_else(|| native_valid.then(|| original.clone())) else {
            projected.push(message.clone());
            continue;
        };
        if !definitions.is_empty() {
            content.push(functions_block(&definitions));
        }
        if !newly_loaded.is_empty() {
            content.push(loaded_reminder(&newly_loaded));
        }
        if !already_loaded.is_empty() {
            content.push(already_loaded_reminder(&already_loaded));
        }
        if content.is_empty() {
            let text = if mode == ResolvedMode::Off {
                "[Tool references removed - tool search not enabled]"
            } else {
                "[Tool references removed - tools no longer available]"
            };
            content.push(json!({"type": "text", "text": text}));
        }
        let mut message = message.clone();
        message["content"] = Value::Array(content);
        projected.push(message);
    }
    Projection {
        messages: append_loaded_messages(projected, &loaded_call_ids),
        loaded_call_ids,
    }
}

/// Node `appendToolSearchSuccessMessages`：成功提示位于整批 tool_result 之后。
/// 只追加 user 提示，不改写结果内容，也不拆开连续/并行 tool 结果。
fn append_loaded_messages(messages: Vec<Value>, loaded_call_ids: &BTreeSet<String>) -> Vec<Value> {
    if loaded_call_ids.is_empty() {
        return messages;
    }
    let mut out = Vec::with_capacity(messages.len() + loaded_call_ids.len());
    let mut pending = 0usize;
    for (index, message) in messages.iter().enumerate() {
        out.push(message.clone());
        if message["role"] == "tool"
            && message["tool_call_id"]
                .as_str()
                .is_some_and(|id| loaded_call_ids.contains(id))
        {
            pending += 1;
        }
        // 只有连续 tool 批次结束后才追加，保持 tool_call_id 顺序。
        if messages
            .get(index + 1)
            .is_none_or(|next| next["role"] != "tool")
        {
            for _ in 0..pending {
                out.push(json!({"role": "user", "content": "Tool loaded."}));
            }
            pending = 0;
        }
    }
    out
}

/// 结果 callID 对应的模型调用是否是 ToolSearch。
fn is_search_call(messages: &[Value], call_id: &str) -> bool {
    messages.iter().any(|message| {
        message["role"] == "assistant"
            && message["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|call| {
                    call["id"].as_str() == Some(call_id)
                        && call["function"]["name"].as_str() == Some(TOOL_SEARCH_NAME)
                })
    })
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
