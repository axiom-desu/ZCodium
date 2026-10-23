use crate::{
    contract::{Event, EventSink, ModelFailure, ModelOutput},
    domain::MAX_TEXT_BYTES,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
use tokio::time::Instant;

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
}
#[derive(Default)]
pub struct Assembly {
    text: String,
    reasoning: String,
    calls: BTreeMap<u64, Call>,
    usage: Value,
    finish: Option<String>,
    /// The provider's finish reason before mapping (`_zcode_raw_finish` of a
    /// translated protocol, else the Chat `finish_reason`).
    raw_finish: Option<String>,
    /// 出现只带签名/加密载荷的推理帧：与 Node `hasReasoningContent` 一致，
    /// 空文本不等于空输出，不能当成空输出的上下文超窗。
    pub(super) reasoning_frames: bool,
    bytes: usize,
    pub done: bool,
}

/// Node `isZeroOutputModelCompletion` 的上下文超窗原因集合（原始 finish reason）。
const CONTEXT_LIMIT_FINISH: [&str; 6] = [
    "context_exceeded",
    "context_length_exceeded",
    "context_window_exceeded",
    "model_context_exceeded",
    "model_context_window_exceeded",
    "prompt_too_long",
];
impl Assembly {
    pub async fn consume(
        &mut self,
        data: &str,
        output: &mut TextBuffer<'_>,
    ) -> Result<(), ModelFailure> {
        if data == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let value: Value = serde_json::from_str(data).map_err(|_| ModelFailure::invalid())?;
        self.consume_value(&value, output).await
    }
    pub(super) async fn consume_value(
        &mut self,
        value: &Value,
        output: &mut TextBuffer<'_>,
    ) -> Result<(), ModelFailure> {
        if value.get("error").is_some_and(|e| !e.is_null()) {
            let mut failure =
                super::model_failure::response(None, value, &reqwest::header::HeaderMap::new());
            let detail = super::network_status::provider_detail(value, Default::default());
            failure.detail = Some(Box::new(detail));
            return Err(failure);
        }
        if value["usage"].is_object() {
            self.usage = value["usage"].clone();
        }
        let choice = &value["choices"][0];
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish = Some(reason.into());
            // Node：`rawFinishReason` 优先取翻译协议的原始原因，其次 provider metadata。
            self.raw_finish = raw_finish(value, choice).map(str::to_owned);
        }
        let delta = &choice["delta"];
        for (key, reasoning) in [("reasoning_content", true), ("content", false)] {
            if let Some(part) = string(&delta[key])?
                && !part.is_empty()
            {
                self.count(part.len())?;
                if reasoning {
                    self.reasoning.push_str(part);
                } else {
                    self.text.push_str(part);
                }
                output.push(part, reasoning).await?;
            }
        }
        if let Some(parts) = delta.get("tool_calls").filter(|v| !v.is_null()) {
            output.first_content.get_or_insert_with(Instant::now);
            output.flush().await?;
            for part in parts.as_array().ok_or_else(ModelFailure::invalid)? {
                let index = part["index"]
                    .as_u64()
                    .filter(|n| *n < 128)
                    .ok_or_else(ModelFailure::invalid)?;
                if part
                    .get("type")
                    .is_some_and(|v| !v.is_null() && v != "function")
                {
                    return Err(ModelFailure::invalid());
                }
                let id = string(&part["id"])?.unwrap_or("");
                let name = string(&part["function"]["name"])?.unwrap_or("");
                let args = string(&part["function"]["arguments"])?.unwrap_or("");
                self.count(id.len() + name.len() + args.len())?;
                if !crate::domain::js_string::trim(args).is_empty() {
                    output.tool().await?;
                }
                let call = self.calls.entry(index).or_default();
                call.id.push_str(id);
                call.name.push_str(name);
                call.arguments.push_str(args);
            }
        }
        Ok(())
    }
    /// A call with a name (Node's completed `tool_call` at the stream end).
    pub(super) fn named_call(&self) -> bool {
        self.calls.values().any(|c| !c.name.trim().is_empty())
    }
    pub(super) fn count(&mut self, bytes: usize) -> Result<(), ModelFailure> {
        self.bytes = self.bytes.saturating_add(bytes);
        if self.bytes > MAX_TEXT_BYTES {
            Err(ModelFailure::invalid())
        } else {
            Ok(())
        }
    }
    /// 空输出且原始结束原因是上下文超窗；任何 partial（文本/推理/工具）都保持原语义。
    fn context_limit_exceeded(&self) -> bool {
        if !self.text.is_empty() || !self.reasoning.is_empty() || self.reasoning_frames {
            return false;
        }
        if !self.calls.is_empty() {
            return false;
        }
        [self.raw_finish.as_deref(), self.finish.as_deref()]
            .into_iter()
            .flatten()
            .any(|reason| {
                let reason = reason.trim().to_ascii_lowercase();
                CONTEXT_LIMIT_FINISH.contains(&reason.as_str())
            })
    }
    pub(super) fn finish(self) -> Result<ModelOutput, ModelFailure> {
        if !self.done {
            return Err(ModelFailure::new("network_error", true));
        }
        let output_limit = matches!(
            self.finish.as_deref(),
            Some("length" | "max_tokens" | "max_output_tokens" | "model_context_window_exceeded")
        );
        if !output_limit && !matches!(self.finish.as_deref(), Some("stop" | "tool_calls")) {
            return Err(ModelFailure::invalid());
        }
        if output_limit && !self.calls.is_empty() {
            return Err(ModelFailure::invalid());
        }
        // 空输出 + 上下文超窗是真实请求失败（Node `createEmptyContextExceededError`）：
        // 带 usage 进入既有失败链，不能压成 `length` 再做无效续写。
        if self.context_limit_exceeded() {
            let mut failure = ModelFailure::new("context_exceeded", false);
            failure.usage = self
                .usage
                .as_object()
                .filter(|u| !u.is_empty())
                .map(|_| Box::new(self.usage.clone()));
            return Err(failure);
        }
        if self.finish.as_deref() == Some("tool_calls") && self.calls.is_empty() {
            return Err(ModelFailure::invalid());
        }
        let mut ids = BTreeSet::new();
        let mut calls = vec![];
        for call in self.calls.into_values() {
            if call.id.trim().is_empty()
                || call.name.trim().is_empty()
                || !ids.insert(call.id.clone())
            {
                return Err(ModelFailure::invalid());
            }
            calls.push(json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments}}));
        }
        if !output_limit
            && self.text.is_empty()
            && calls.is_empty()
            && self.usage.as_object().is_none_or(|m| m.is_empty())
        {
            return Err(ModelFailure::empty());
        }
        let mut message = json!({"role":"assistant","content":self.text});
        if !self.reasoning.is_empty() {
            message["reasoning_content"] = self.reasoning.into();
        }
        if !calls.is_empty() {
            message["tool_calls"] = calls.clone().into();
        }
        Ok(ModelOutput {
            message,
            calls,
            usage: self.usage,
            output_limit,
            raw_finish_reason: self.raw_finish,
        })
    }
}
fn string(value: &Value) -> Result<Option<&str>, ModelFailure> {
    if value.is_null() {
        Ok(None)
    } else {
        value.as_str().map(Some).ok_or_else(ModelFailure::invalid)
    }
}

/// Node `rawFinishReason` 回退链：翻译协议的 `_zcode_raw_finish`，其次 provider metadata，
/// 最后才是归一化 finish reason。
fn raw_finish<'a>(value: &'a Value, choice: &'a Value) -> Option<&'a str> {
    // 翻译帧一旦带 `_zcode_raw_finish`（包括显式 null）就是该帧的完整事实：
    // Responses `completed` 的 null 表示 provider 没有原始原因，不能伪造成归一化 `stop`。
    if let Some(raw) = choice.get("_zcode_raw_finish") {
        return raw.as_str();
    }
    [
        &choice["providerMetadata"],
        &value["providerMetadata"],
        &value["provider_metadata"],
    ]
    .into_iter()
    .find_map(|metadata| {
        metadata["rawFinishReason"]
            .as_str()
            .or_else(|| metadata["raw_finish_reason"].as_str())
    })
    .or_else(|| choice["finish_reason"].as_str())
}

pub struct TextBuffer<'a> {
    sink: &'a EventSink,
    response: String,
    pending: String,
    reasoning: bool,
    pub deadline: Option<Instant>,
    pub committed: bool,
    /// First text, reasoning or tool-call output (Node `timeToFirstContentMs`).
    pub first_content: Option<Instant>,
    /// First non-empty answer text (Node `timeToFirstTextMs`).
    pub first_text: Option<Instant>,
    tool_output: bool,
}
impl<'a> TextBuffer<'a> {
    pub fn new(sink: &'a EventSink) -> Self {
        Self {
            sink,
            response: super::id(),
            pending: String::new(),
            reasoning: false,
            deadline: None,
            committed: false,
            first_content: None,
            first_text: None,
            tool_output: false,
        }
    }
    /// The first tool-call output of the response, reported once.
    pub async fn tool(&mut self) -> Result<(), ModelFailure> {
        if std::mem::replace(&mut self.tool_output, true) {
            return Ok(());
        }
        self.sink
            .send(Event::ToolStreaming)
            .await
            .map_err(|_| ModelFailure::cancelled())
    }
    /// Reports one model network status to the run.
    pub async fn status(&self, payload: serde_json::Value) -> Result<(), ModelFailure> {
        self.sink
            .send(Event::ModelStatus(payload))
            .await
            .map_err(|_| ModelFailure::cancelled())
    }
    /// Attribution of the run this output belongs to.
    pub fn origin(&self) -> std::sync::Arc<crate::contract::RequestOrigin> {
        self.sink.origin.clone()
    }
    async fn push(&mut self, mut text: &str, reasoning: bool) -> Result<(), ModelFailure> {
        self.first_content.get_or_insert_with(Instant::now);
        if !reasoning {
            self.first_text.get_or_insert_with(Instant::now);
        }
        if self.reasoning != reasoning {
            self.flush().await?;
        }
        self.reasoning = reasoning;
        while !text.is_empty() {
            let mut take = text.len().min(8192 - self.pending.len());
            while !text.is_char_boundary(take) {
                take -= 1;
            }
            if take == 0 {
                self.flush().await?;
                continue;
            }
            self.pending.push_str(&text[..take]);
            text = &text[take..];
            self.deadline
                .get_or_insert_with(|| Instant::now() + Duration::from_millis(16));
            if !self.committed || self.pending.len() >= 8192 || !text.is_empty() {
                self.flush().await?;
            }
        }
        Ok(())
    }
    pub async fn flush(&mut self) -> Result<(), ModelFailure> {
        self.deadline = None;
        if self.pending.is_empty() {
            return Ok(());
        }
        self.sink
            .send(Event::Text {
                response_id: self.response.clone(),
                text: std::mem::take(&mut self.pending),
                reasoning: self.reasoning,
            })
            .await
            .map_err(|_| ModelFailure::cancelled())?;
        self.committed = true;
        Ok(())
    }
}
