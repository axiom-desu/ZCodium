use super::anthropic_rounds::SERVER_BLOCKS;
use super::anthropic_rounds::{Held, Role};
use super::{
    model_protocol::{delta, index, required},
    model_stream::{Assembly, TextBuffer},
};
use crate::contract::{ModelFailure, ModelOutput};
use serde_json::{Value, json};
use std::collections::BTreeMap;
/// 规范化后的 provider 原生块挂在助手消息上，下一次请求按原顺序回放。
const SERVER_TOOLS_KEY: &str = "_zcode_anthropic_server_tools";
/// 3.18 R2：provider 原生工具按「服务端轮次」落库与回放。
/// 每段 `{thinking, text, call, result}`：调用前属于该段的推理/正文 + 调用 + 结果；
/// 末段 `call = null` 只带最后一段正文（结果之后再无调用的尾部）。
pub const SERVER_ROUNDS_KEY: &str = zcode_cli_domain::provider_rounds::KEY;
/// 服务端不一定遵守 schema：缺 `server_name` 的 `mcp_tool_use` 会被 provider 拒绝整轮。
pub(super) const PROVIDER_BUILTIN_SERVER_NAME: &str = "zcode-provider-builtin";

#[derive(Default)]
pub(super) struct Anthropic {
    pub inner: Assembly,
    /// The request carried provider-native tools (WebSearch's internal call).
    pub(super) server_tools: bool,
    blocks: BTreeMap<u64, Block>,
    /// 本条消息里已见过的服务端调用 id（结果块只有配对时才回放）。
    pub(super) calls: std::collections::BTreeSet<String>,
    /// 服务端调用 id → 工具名（结果摘要副本的身份）。
    pub(super) call_names: BTreeMap<String, String>,
    /// 规范化后按到达顺序保留的 provider 原生块。
    pub(super) server_blocks: Vec<Value>,
    /// 服务端轮次（唯一事实：落库与回放都从这里派生）。
    pub(super) rounds: Vec<super::anthropic_rounds::Round>,
    /// 当前段内已收完的推理块。
    pub(super) pending_thinking: Vec<Value>,
    /// 上个轮次之后、下个调用之前的可见正文。
    pub(super) pending_text: String,
    /// 缓冲中的正文块（`server_tools` 消息内才缓冲）。
    pub(super) held: Option<super::anthropic_rounds::Held>,
    /// 上一个服务端调用 id：紧跟其后的正文可能是结果副本。
    pub(super) after_call: Option<String>,
    /// 上一个配对结果的工具名：紧跟其后的正文可能是结果摘要副本。
    pub(super) after_result: Option<String>,
    /// 展示位不丢的 provider 原生块数与 `server_blocks` 对齐。
    started: bool,
    stopped: bool,
    usage: Value,
}
struct Block {
    value: Value,
    arguments: String,
    closed: bool,
    signature_delta: bool,
    /// `server_blocks` 里的位置；`None` 表示这一块不回放（未配对的结果）。
    server: Option<usize>,
}
impl Anthropic {
    pub fn new(server_tools: bool) -> Self {
        Self {
            server_tools,
            ..Default::default()
        }
    }
    pub async fn consume(
        &mut self,
        data: &str,
        output: &mut TextBuffer<'_>,
    ) -> Result<(), ModelFailure> {
        let value: Value = serde_json::from_str(data).map_err(|_| ModelFailure::invalid())?;
        match required(&value["type"])? {
            "error" => {
                return Err(super::model_failure::response(
                    None,
                    &value,
                    &Default::default(),
                ));
            }
            "message_start" => {
                if self.started {
                    return Err(ModelFailure::invalid());
                }
                self.started = true;
                self.usage = value["message"]["usage"].clone();
            }
            "content_block_start" => {
                let n = index(&value["index"])?;
                if !self.started || self.stopped || self.blocks.contains_key(&n) {
                    return Err(ModelFailure::invalid());
                }
                let block = &value["content_block"];
                let mut args = String::new();
                let mut server = None;
                // 新块开始前先结算缓冲的正文：副本按结构确认后丢弃，其余按原顺序进入正文。
                let kind = required(&block["type"])?;
                self.settle_held(output, kind, block).await?;
                match kind {
                    "tool_use" => {
                        if !block["input"].is_object() {
                            return Err(ModelFailure::invalid());
                        }
                        if block["input"].as_object().is_some_and(|o| !o.is_empty()) {
                            args = block["input"].to_string();
                        }
                        delta(&mut self.inner,output,json!({"tool_calls":[{"index":n,"id":block["id"],"type":"function","function":{"name":block["name"],"arguments":args}}]})).await?;
                    }
                    "text" => {
                        // 带 provider 原生工具的消息里，正文可能是服务端的 markdown 渲染副本：
                        // 整块缓冲到下一个块（或消息结束）才决定去留。
                        if self.server_tools {
                            self.held = Some(Held {
                                index: n,
                                text: block["text"].as_str().unwrap_or("").to_owned(),
                                role: self.next_text_role(),
                            });
                        } else {
                            delta(
                                &mut self.inner,
                                output,
                                json!({"content":required(&block["text"])?}),
                            )
                            .await?;
                        }
                    }
                    "thinking" => {
                        // 即使文本为空，签名帧也算有推理内容（Node hasReasoningContent）。
                        self.inner.reasoning_frames = true;
                        self.inner
                            .count(block["signature"].as_str().map_or(0, str::len))?;
                        delta(
                            &mut self.inner,
                            output,
                            json!({"reasoning_content":required(&block["thinking"])?}),
                        )
                        .await?
                    }
                    "redacted_thinking" => {
                        self.inner.reasoning_frames = true;
                        self.inner.count(required(&block["data"])?.len())?;
                    }
                    // 3.18 F11：provider 原生块按到达顺序规范化保留，不再静默丢弃。
                    kind if self.server_tools && SERVER_BLOCKS.contains(&kind) => {
                        server = self.start_server_block(kind, block);
                        match kind {
                            "server_tool_use" | "mcp_tool_use" => {
                                if server.is_some() {
                                    self.after_call = block["id"].as_str().map(str::to_owned);
                                }
                            }
                            _ => {
                                if let Some(name) = server
                                    .and_then(|_| block["tool_use_id"].as_str())
                                    .and_then(|id| self.call_names.get(id).cloned())
                                {
                                    self.after_result = Some(name);
                                }
                            }
                        }
                    }
                    _ => return Err(ModelFailure::invalid()),
                }
                self.blocks.insert(
                    n,
                    Block {
                        value: match block["type"].as_str() {
                            Some("thinking")=>json!({"type":"thinking","thinking":block["thinking"],"signature":block["signature"].as_str().unwrap_or("")}),
                            Some("redacted_thinking")=>json!({"type":"redacted_thinking","data":block["data"]}),
                            _=>json!({"type":block["type"]}),
                        },
                        arguments: args,
                        closed: false,
                        signature_delta: false,
                        server,
                    },
                );
            }
            "content_block_delta" => {
                let n = index(&value["index"])?;
                let block = self.blocks.get_mut(&n).ok_or_else(ModelFailure::invalid)?;
                if block.closed || self.stopped {
                    return Err(ModelFailure::invalid());
                }
                let d = &value["delta"];
                match required(&d["type"])? {
                    "input_json_delta" if block.value["type"] == "tool_use" => {
                        let args = required(&d["partial_json"])?;
                        block.arguments.push_str(args);
                        delta(
                            &mut self.inner,
                            output,
                            json!({"tool_calls":[{"index":n,"function":{"arguments":args}}]}),
                        )
                        .await?;
                    }
                    "text_delta" if block.value["type"] == "text" => {
                        let text = required(&d["text"])?;
                        if let Some(held) = self.held.as_mut().filter(|h| h.index == n) {
                            held.text.push_str(text);
                        } else {
                            delta(&mut self.inner, output, json!({"content":text})).await?;
                        }
                    }
                    "thinking_delta" if block.value["type"] == "thinking" => {
                        let text = required(&d["thinking"])?;
                        let Value::String(thinking) = &mut block.value["thinking"] else {
                            return Err(ModelFailure::invalid());
                        };
                        thinking.push_str(text);
                        delta(&mut self.inner, output, json!({"reasoning_content":text})).await?;
                    }
                    "signature_delta" if block.value["type"] == "thinking" => {
                        let signature = required(&d["signature"])?;
                        self.inner.count(signature.len())?;
                        let Value::String(current) = &mut block.value["signature"] else {
                            return Err(ModelFailure::invalid());
                        };
                        // 首段替换供应商在 start 中的占位签名；后续原地追加，避免分片越多复制越多。
                        if !block.signature_delta {
                            current.clear();
                        }
                        block.signature_delta = true;
                        current.push_str(signature);
                    }
                    // 原生工具块（含被丢弃的未配对结果）的增量不进入模型输出：
                    // 只有 `mcp_tool_use` 的入参要累积，其余（引用、结果正文）已随 start 到达。
                    _ if self.server_tools
                        && (SERVER_BLOCKS
                            .contains(&block.value["type"].as_str().unwrap_or(""))
                            || d["type"] == "citations_delta") =>
                    {
                        if d["type"] == "input_json_delta" && block.server.is_some() {
                            block.arguments.push_str(required(&d["partial_json"])?);
                        }
                    }
                    _ => return Err(ModelFailure::invalid()),
                }
            }
            "content_block_stop" => {
                let n = index(&value["index"])?;
                let (empty_arguments, thinking) = {
                    let block = self.blocks.get_mut(&n).ok_or_else(ModelFailure::invalid)?;
                    if block.closed || self.stopped {
                        return Err(ModelFailure::invalid());
                    }
                    if let Some(index) = block.server
                        && matches!(
                            block.value["type"].as_str(),
                            Some("server_tool_use" | "mcp_tool_use")
                        )
                    {
                        let mut input = Value::Null;
                        if !block.arguments.is_empty() {
                            input = serde_json::from_str(&block.arguments)
                                .map_err(|_| ModelFailure::invalid())?;
                            if !input.is_object() {
                                return Err(ModelFailure::invalid());
                            }
                        }
                        if input.is_object() {
                            self.server_blocks[index]["input"] = input;
                        }
                    }
                    let empty_arguments =
                        block.value["type"] == "tool_use" && block.arguments.is_empty();
                    if block.value["type"] == "tool_use" {
                        if empty_arguments {
                            block.arguments = "{}".into();
                        }
                        if !serde_json::from_str::<Value>(&block.arguments)
                            .is_ok_and(|v| v.is_object())
                        {
                            return Err(ModelFailure::invalid());
                        }
                    }
                    // 收完的推理块进入当前轮次：冷恢复按同一分段重建。
                    let thinking = matches!(
                        block.value["type"].as_str(),
                        Some("thinking" | "redacted_thinking")
                    )
                    .then(|| block.value.clone());
                    block.closed = true;
                    (empty_arguments, thinking)
                };
                if empty_arguments {
                    delta(
                        &mut self.inner,
                        output,
                        json!({"tool_calls":[{"index":n,"function":{"arguments":"{}"}}]}),
                    )
                    .await?;
                }
                if let Some(thinking) = thinking {
                    self.pending_thinking.push(thinking);
                }
                // 摘要副本后面没有结构块可确认，整块收完就按工具名标签结算。
                if let Some(held) = self.held.as_ref().filter(|h| h.index == n)
                    && matches!(held.role, Role::Summary(_))
                {
                    self.settle_held(output, "end", &Value::Null).await?;
                }
            }
            "message_delta" => {
                if !self.started || self.stopped || self.blocks.values().any(|b| !b.closed) {
                    return Err(ModelFailure::invalid());
                }
                // 尾部正文在结束原因之前落地，流式顺序与冷恢复一致。
                self.settle_held(output, "end", &Value::Null).await?;
                if let Some(usage) = value["usage"].as_object() {
                    self.usage
                        .as_object_mut()
                        .ok_or_else(ModelFailure::invalid)?
                        .extend(usage.clone());
                }
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    let finish = match reason {
                        "end_turn" | "stop_sequence" => "stop",
                        "tool_use" => "tool_calls",
                        "max_tokens" | "model_context_window_exceeded" => "length",
                        // 原生搜索可暂停或拒答：按正常结束收取已有文本。
                        "pause_turn" | "refusal" if self.server_tools => "stop",
                        _ => return Err(ModelFailure::invalid()),
                    };
                    let has_calls = self.blocks.values().any(|b| b.value["type"] == "tool_use");
                    if (reason == "tool_use") != has_calls {
                        return Err(ModelFailure::invalid());
                    }
                    let input = self.usage["input_tokens"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_add(self.usage["cache_read_input_tokens"].as_u64().unwrap_or(0))
                        .saturating_add(
                            self.usage["cache_creation_input_tokens"]
                                .as_u64()
                                .unwrap_or(0),
                        );
                    let mut usage = if self.usage.as_object().is_some_and(|u| !u.is_empty()) {
                        json!({"prompt_tokens":input,"completion_tokens":self.usage["output_tokens"],"prompt_tokens_details":{"cached_tokens":self.usage["cache_read_input_tokens"],"cache_write_tokens":self.usage["cache_creation_input_tokens"]}})
                    } else {
                        Value::Null
                    };
                    // Node `normalizeUsage` 读取原始 usage 的 server_tool_use（原生搜索与抓取次数）。
                    if self.usage["server_tool_use"].is_object() {
                        usage["server_tool_use"] = self.usage["server_tool_use"].clone();
                    }
                    self.inner.consume_value(&json!({"choices":[{"delta":{},"finish_reason":finish,"_zcode_raw_finish":reason}],"usage":usage}),output).await?;
                    self.stopped = true;
                }
            }
            "message_stop" => {
                if !self.stopped || self.blocks.values().any(|b| !b.closed) {
                    return Err(ModelFailure::invalid());
                }
                // 最后一段正文（可能是尾部正文，也可能是没有后续调用的调用头副本）先结算。
                self.settle_held(output, "end", &Value::Null).await?;
                self.inner.done = true;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<ModelOutput, ModelFailure> {
        // 3.18 F11/R2：段列表与平铺块都从 `server_blocks` 派生，必须在移动 `inner` 之前收尾。
        self.close_tail();
        let blocks = std::mem::take(&mut self.server_blocks);
        let rounds = self.segments(&blocks);
        let mut output = self.inner.finish()?;
        let thinking = self
            .blocks
            .into_values()
            .filter(|b| {
                matches!(
                    b.value["type"].as_str(),
                    Some("thinking" | "redacted_thinking")
                )
            })
            .map(|b| b.value)
            .collect::<Vec<_>>();
        if !thinking.is_empty() {
            output.message["_zcode_anthropic_thinking"] = thinking.into();
        }
        if !blocks.is_empty() {
            output.message[SERVER_TOOLS_KEY] = Value::Array(blocks);
            if !rounds.is_empty() {
                output.message[SERVER_ROUNDS_KEY] = rounds.into();
            }
        }
        Ok(output)
    }
}
