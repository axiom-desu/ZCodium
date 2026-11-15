//! 工具结果的协议投影（结果正文与后续媒体拆分、Anthropic/Responses 形状）。
//! 拆分自 `model_protocol.rs`，函数体逐字搬移，只为把源文件保持在 400 行上限内。
use super::ModelFailure;
use serde_json::{Value, json};

/// A tool result's content split into what the protocol carries in the
/// result and the media that follow it (video has no tool-result form).
pub(super) fn split_tool_media(
    message: &Value,
    names: &std::collections::HashMap<String, String>,
) -> Option<(Vec<Value>, Option<Value>)> {
    let parts = message["content"].as_array()?;
    let (videos, kept): (Vec<Value>, Vec<Value>) =
        parts.iter().cloned().partition(crate::tool_media::is_video);
    let name = names
        .get(message["tool_call_id"].as_str().unwrap_or(""))
        .map_or("", String::as_str);
    let mut kept: Vec<Value> = kept.into_iter().map(crate::tool_media::clean).collect();
    if !videos.is_empty() {
        // 视频以文本占位留在结果中，媒体随后作为 user 内容发送（Node 所有协议相同）。
        let text = crate::tool_media::text_form(&videos);
        kept.push(json!({"type":"text","text":text}));
    }
    Some((kept, crate::tool_media::deferred(name, videos)))
}
pub(super) fn anthropic_tool_content(
    message: &Value,
    names: &std::collections::HashMap<String, String>,
    tool_search: bool,
) -> Result<(Value, Option<Value>), ModelFailure> {
    match split_tool_media(message, names) {
        Some((kept, deferred)) => {
            let blocks = crate::model_media::anthropic(&Value::Array(kept), tool_search)?;
            Ok((blocks.into(), deferred))
        }
        None => Ok((message["content"].clone(), None)),
    }
}
pub(super) fn responses_tool_output(
    message: &Value,
    names: &std::collections::HashMap<String, String>,
) -> Result<(Value, Option<Value>), ModelFailure> {
    match split_tool_media(message, names) {
        Some((kept, deferred)) => {
            let output = crate::model_media::responses(&Value::Array(kept), "user")?;
            Ok((output.into(), deferred))
        }
        None => Ok((message["content"].clone(), None)),
    }
}
