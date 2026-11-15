// 3.18 R2：provider 原生工具的服务端轮次与渲染副本抑制
// （`.agents/specs/upstream-3.18-rust-parity.md` A 节）。
//
// 服务端把多轮结果合成一次响应下发：text(渲染的调用头) → server_tool_use → text(渲染的结果)
// → tool_result → 下一轮。这里按轮切分（调用前属于该轮的推理/正文 + 调用 + 结果），并按
// 「前缀 + 紧跟结构」确认去重服务端自己渲染的 markdown 副本；确认不了就原样保留，
// 不做「见到 `**` 就删」的宽松匹配（会误删模型正文）。
use super::{
    anthropic_stream::{Anthropic, PROVIDER_BUILTIN_SERVER_NAME},
    model_protocol::delta,
    model_stream::TextBuffer,
};
use crate::contract::ModelFailure;
use serde_json::{Value, json};

/// Provider 原生工具块类型（3.18 F11）：服务端调用与结果，不再静默丢弃。
pub(super) const SERVER_BLOCKS: [&str; 9] = [
    "server_tool_use",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    // BigModel's bare result form, and the native MCP form of the new servers.
    "tool_result",
    "mcp_tool_use",
    "mcp_tool_result",
];
pub(super) const RESULT_BLOCKS: [&str; 6] = [
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "mcp_tool_result",
];

/// 服务端渲染副本的前缀（上游 `RENDERING_PREFIX`，不写厂商名）。
const RENDER_CALL: &str = "**🌐";
const RENDER_RESULT: &str = "**";
const RENDER_SUMMARY: &str = "**Output:**";

/// 一个服务端轮次：调用前的推理/正文、调用块、配对结果块（块本身在 `server_blocks` 里）。
#[derive(Default)]
pub(super) struct Round {
    thinking: Vec<Value>,
    text: String,
    call: Option<usize>,
    result: Option<usize>,
}

/// 缓冲中的正文块：确认是不是服务端的 markdown 渲染副本。
pub(super) struct Held {
    pub(super) index: u64,
    pub(super) text: String,
    pub(super) role: Role,
}

pub(super) enum Role {
    /// 可能是调用头副本：只有紧跟服务端调用时才算副本。
    Call,
    /// 紧跟服务端调用的正文：只有紧跟其配对结果时才算结果副本。
    Result(String),
    /// 紧跟配对结果的正文：按 `<工具名>_result_summary` 标签确认摘要副本。
    Summary(String),
}

impl Anthropic {
    /// 一个 provider 原生块的规范化：调用记录配对并保留，结果只有配对了才保留。
    /// 返回它在 `server_blocks` 里的位置；`None` 表示这一块不回放。
    pub(super) fn start_server_block(&mut self, kind: &str, block: &Value) -> Option<usize> {
        match kind {
            "server_tool_use" | "mcp_tool_use" => {
                let id = block["id"].as_str()?;
                self.calls.insert(id.to_owned());
                let mut out = json!({
                    "type": kind,
                    "id": id,
                    "name": block["name"],
                    "input": if block["input"].is_object() { block["input"].clone() } else { json!({}) },
                });
                // 服务端不一定遵守 schema：缺 `server_name` 的 `mcp_tool_use` 让整轮失败。
                if kind == "mcp_tool_use" {
                    out["server_name"] = match block["server_name"].as_str() {
                        Some(name) => json!(name),
                        None => json!(PROVIDER_BUILTIN_SERVER_NAME),
                    };
                }
                self.call_names.insert(
                    id.to_owned(),
                    block["name"].as_str().unwrap_or("").to_owned(),
                );
                self.server_blocks.push(out);
                let index = self.server_blocks.len() - 1;
                self.push_round(index);
                Some(index)
            }
            _ if RESULT_BLOCKS.contains(&kind) || kind == "tool_result" => {
                // 没有配对调用的结果会让 provider 拒绝整轮：丢弃（不静默改正文）。
                let id = block["tool_use_id"].as_str()?;
                if !self.calls.contains(id) {
                    return None;
                }
                // 结果块按 provider 的原始形状回放（服务端工具的类型与内容由它自己定义）。
                self.server_blocks.push(block.clone());
                let index = self.server_blocks.len() - 1;
                self.attach_result(index);
                Some(index)
            }
            _ => None,
        }
    }
    /// 新轮次：调用前的推理/正文属于这一轮（块本身留在 `server_blocks`）。
    pub(super) fn push_round(&mut self, call: usize) {
        self.rounds.push(Round {
            thinking: std::mem::take(&mut self.pending_thinking),
            text: std::mem::take(&mut self.pending_text),
            call: Some(call),
            result: None,
        });
    }

    /// 配对结果挂到等待结果的最后一轮。
    pub(super) fn attach_result(&mut self, result: usize) {
        if let Some(round) = self.rounds.iter_mut().rev().find(|r| r.result.is_none()) {
            round.result = Some(result);
        }
    }

    /// 缓冲正文的角色：紧跟调用的正文可能是结果副本，紧跟结果的正文可能是摘要副本。
    pub(super) fn next_text_role(&mut self) -> Role {
        if let Some(call) = self.after_call.take() {
            return Role::Result(call);
        }
        if let Some(tool) = self.after_result.take() {
            return Role::Summary(tool);
        }
        Role::Call
    }

    /// 结算缓冲正文：`next` 是即将开始的块（`"end"` 表示消息结束）。
    /// 服务端渲染副本按前缀 + 紧跟结构确认后丢弃；确认不了按原样保留（不误删模型正文）。
    pub(super) async fn settle_held(
        &mut self,
        output: &mut TextBuffer<'_>,
        next: &str,
        block: &Value,
    ) -> Result<(), ModelFailure> {
        // 调用头/结果/摘要副本要求紧跟同一结构块；中间插了别的块就不再是副本候选。
        if next != "text" {
            self.after_call = None;
            self.after_result = None;
        }
        let Some(held) = self.held.take() else {
            return Ok(());
        };
        let trimmed = held.text.trim_start();
        let drop = match &held.role {
            // 调用头副本：紧跟服务端调用。
            Role::Call => {
                matches!(next, "server_tool_use" | "mcp_tool_use")
                    && trimmed.starts_with(RENDER_CALL)
            }
            // 结果副本：紧跟该调用的配对结果。
            Role::Result(call) => {
                (RESULT_BLOCKS.contains(&next) || next == "tool_result")
                    && block["tool_use_id"].as_str() == Some(call.as_str())
                    && trimmed.starts_with(RENDER_RESULT)
            }
            // 新格式摘要副本：按 `<工具名>_result_summary` 标签确认。
            Role::Summary(tool) => {
                trimmed.starts_with(RENDER_SUMMARY)
                    && trimmed[RENDER_SUMMARY.len()..]
                        .trim_start()
                        .starts_with(&format!("**{tool}_result_summary:**"))
            }
        };
        if drop {
            return Ok(());
        }
        self.flush_text(output, held.text).await
    }

    /// 正文落地：顺序追加到当前轮次与模型输出。
    pub(super) async fn flush_text(
        &mut self,
        output: &mut TextBuffer<'_>,
        text: String,
    ) -> Result<(), ModelFailure> {
        if text.is_empty() {
            return Ok(());
        }
        self.pending_text.push_str(&text);
        delta(&mut self.inner, output, json!({"content": text})).await
    }

    /// 结果之后再无调用的尾部（推理/正文）收成末段。
    pub(super) fn close_tail(&mut self) {
        let thinking = std::mem::take(&mut self.pending_thinking);
        let text = std::mem::take(&mut self.pending_text);
        if thinking.is_empty() && text.is_empty() {
            return;
        }
        self.rounds.push(Round {
            thinking,
            text,
            ..Round::default()
        });
    }

    /// 落库/回放用的段列表；`blocks` 是规范化后的 provider 原生块。
    pub(super) fn segments(&self, blocks: &[Value]) -> Vec<Value> {
        self.rounds
            .iter()
            .filter(|round| {
                round.call.is_some() || !round.text.is_empty() || !round.thinking.is_empty()
            })
            .map(|round| {
                json!({
                    "thinking": round.thinking,
                    "text": round.text,
                    "call": round.call.map(|i| blocks[i].clone()),
                    "result": round.result.map(|i| blocks[i].clone()),
                })
            })
            .collect()
    }
}
