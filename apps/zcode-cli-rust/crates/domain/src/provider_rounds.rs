//! Provider 原生工具轮次（3.18 R2，`.agents/specs/upstream-3.18-rust-parity.md` A 节）。
//!
//! 服务端执行内置工具（web_search / mcp_*）后把多轮结果合成一次响应下发。官方按轮拆分：
//! 每轮是「该调用之前的推理/正文 + 调用 + 结果」，回放时必须写成
//! assistant(调用) + user(结果)，不能把多轮正文拼进一条 assistant。
//!
//! 唯一事实是助手消息上的段列表；平铺块（`_zcode_anthropic_server_tools`）、落库 part、
//! 冷恢复三处都从同一份段派生，不各自维护第二份状态。
use serde_json::{Map, Value, json};

/// 助手消息上的段列表键（`[{thinking,text,call,result}]`）。
pub const KEY: &str = "_zcode_anthropic_server_rounds";
/// 落库 tool part 上的标记：provider 已在服务端执行，客户端不执行、冷恢复按轮切回。
pub const EXECUTED_KEY: &str = "providerExecuted";
/// tool part metadata 里的 provider 原始块（冷恢复按原形状回放，不重新合成）。
pub const CALL_BLOCK_KEY: &str = "providerCallBlock";
pub const RESULT_BLOCK_KEY: &str = "providerResultBlock";
/// `mcp_tool_use` 缺 `server_name` 时补齐的值（与 model 侧常量同义）。
pub const PROVIDER_BUILTIN_SERVER_NAME: &str = "zcode-provider-builtin";

/// 该 tool part 是 provider 在服务端执行的调用（不参与本地工具执行）。
pub fn executed(part: &Value) -> bool {
    part["type"] == "tool" && part["metadata"][EXECUTED_KEY] == true
}

/// 段列表（没有则空）。
pub fn segments(message: &Value) -> &[Value] {
    message[KEY].as_array().map_or(&[], Vec::as_slice)
}

/// 服务端结果块的模型可读正文：mcp/裸结果取 text/正文，其余按 JSON 保留（不丢结构）。
pub fn result_text(block: &Value) -> String {
    match &block["content"] {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item["text"]
                    .as_str()
                    .map_or_else(|| crate::js_json::stringify(item), str::to_owned)
            })
            .collect(),
        Value::Null => crate::js_json::stringify(block),
        other => crate::js_json::stringify(other),
    }
}

/// Node reasoning part（`{text, providerOptions}`）→ canonical Anthropic thinking 块。
fn thinking_block(part: &Value) -> Value {
    let anthropic = &part["metadata"]["anthropic"];
    if let Some(data) = anthropic["redactedData"].as_str() {
        return json!({"type": "redacted_thinking", "data": data});
    }
    json!({
        "type": "thinking",
        "thinking": part["text"].as_str().unwrap_or(""),
        "signature": anthropic["signature"].as_str().unwrap_or(""),
    })
}

/// 冷恢复：按 part 顺序切回段列表。没有 provider 执行 part 的旧数据返回 `None`。
///
/// 切轮规则与上游 `splitProviderToolRoundParts` 一致：tool part 之前的 reasoning/text
/// 属于该轮；其余 part 忽略。结果块优先取落库的 provider 原始块，
/// 没有时按通用 MCP 形状重建（重放仍然合法）。
pub fn from_parts(parts: &[Value]) -> Option<Vec<Value>> {
    if !parts.iter().any(executed) {
        return None;
    }
    let mut rounds: Vec<Value> = vec![];
    let mut thinking: Vec<Value> = vec![];
    let mut text = String::new();
    let mut any_call = false;
    for part in parts {
        if executed(part) {
            any_call = true;
            let call = part["metadata"][CALL_BLOCK_KEY]
                .as_object()
                .map(|_| part["metadata"][CALL_BLOCK_KEY].clone())
                .unwrap_or_else(|| {
                    let mut call = json!({
                        "type": "mcp_tool_use",
                        "id": part["callID"],
                        "name": part["tool"],
                        "input": part["state"]["input"],
                        "server_name": PROVIDER_BUILTIN_SERVER_NAME,
                    });
                    if !call["input"].is_object() {
                        call["input"] = json!({});
                    }
                    call
                });
            let result = part["metadata"][RESULT_BLOCK_KEY]
                .as_object()
                .map(|_| part["metadata"][RESULT_BLOCK_KEY].clone())
                .unwrap_or_else(|| {
                    let (output, failed) = match part["state"]["status"].as_str() {
                        Some("completed") => (&part["state"]["output"], false),
                        _ => (&part["state"]["error"], true),
                    };
                    json!({
                        "type": "mcp_tool_result",
                        "tool_use_id": part["callID"],
                        "is_error": failed,
                        "content": [{"type": "text", "text": output.as_str().unwrap_or("")}],
                    })
                });
            rounds.push(json!({
                "thinking": std::mem::take(&mut thinking),
                "text": std::mem::take(&mut text),
                "call": call,
                "result": result,
            }));
            continue;
        }
        match part["type"].as_str() {
            Some("reasoning") => thinking.push(thinking_block(part)),
            Some("text") => {
                if let Some(body) = part["text"].as_str().filter(|t| !t.is_empty()) {
                    if !text.is_empty() && !text.ends_with(char::is_whitespace) {
                        text.push_str("\n\n");
                    }
                    text.push_str(body);
                }
            }
            _ => {}
        }
    }
    if !thinking.is_empty() || !text.is_empty() {
        rounds.push(json!({
            "thinking": thinking,
            "text": text,
            "call": Value::Null,
            "result": Value::Null,
        }));
    }
    any_call
        .then_some(rounds)
        .filter(|rounds| !rounds.is_empty())
}

/// 平铺线事实（复用既有助手消息键）：调用与结果按到达顺序展开。
pub fn flat_blocks(rounds: &[Value]) -> Value {
    let mut blocks = vec![];
    for round in rounds {
        if round["call"].is_object() && round["result"].is_object() {
            blocks.push(round["call"].clone());
            blocks.push(round["result"].clone());
        }
    }
    Value::Array(blocks)
}

/// 所有段的可见正文拼接（热/冷 canonical 的 `content` 必须是同一份字节）。
pub fn content(rounds: &[Value]) -> String {
    rounds
        .iter()
        .filter_map(|round| round["text"].as_str())
        .collect()
}

/// 段列表里的全部推理块（顺序与出现顺序一致）。
pub fn thinking(rounds: &[Value]) -> Vec<Value> {
    rounds
        .iter()
        .filter_map(|round| round["thinking"].as_array())
        .flatten()
        .cloned()
        .collect()
}

/// 段字段读取（hydrate/journal 共用的窄访问器）。
pub fn field(round: &Value, key: &str) -> Value {
    round.get(key).cloned().unwrap_or(Value::Null)
}

/// 段是否是末段（没有调用）。
pub fn tail(round: &Value) -> bool {
    !round["call"].is_object()
}

/// 空对象（`Value::Object(Map::new())`）便于测试与默认值。
pub fn empty() -> Value {
    Value::Object(Map::new())
}
