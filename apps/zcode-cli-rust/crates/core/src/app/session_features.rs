//! 上游 3.18.2 F12：run 侧能力标签打点。owner 仍是 Engine 的 `Session.session_features`；
//! 本 run 只持副本，新标签通过 `Event::SessionFeatures` 交回，owner 并集写入 session_entry。
use super::context::RunContext;
use crate::contract::{Event, EventSink, ModelRequestOptions, ToolOutput};
use anyhow::Result;
use serde_json::Value;

/// 记录一项能力；已有该标签时 no-op，因此本 run 的后续请求立刻带上它。
pub(super) async fn record(
    history: &mut RunContext,
    feature: &'static str,
    sink: &EventSink,
) -> Result<()> {
    if !history.session_features.insert(feature.to_owned()) {
        return Ok(());
    }
    publish(history, sink).await
}

async fn publish(history: &RunContext, sink: &EventSink) -> Result<()> {
    let features: Vec<String> = history.session_features.iter().cloned().collect();
    sink.send(Event::SessionFeatures { features }).await
}

/// 请求准备之后把当前快照写进本步请求选项（模型只读快照，不自行推导）。
pub(super) fn apply(history: &RunContext, options: &mut ModelRequestOptions) {
    options.session_features = history.session_features.iter().cloned().collect();
}

/// 工具结果结算后的派生标签；只读结果，不改结算流程。
pub(super) async fn from_tool_result(
    history: &mut RunContext,
    name: &str,
    failed: bool,
    output: &ToolOutput,
    sink: &EventSink,
) -> Result<()> {
    let meta = tool_meta(output);
    let payload = serde_json::json!({"_meta": meta});
    for feature in crate::domain::session_features::from_tool_result(name, failed, &payload) {
        record(history, feature, sink).await?;
    }
    Ok(())
}

/// node-repl-host 写入的 `_meta`：结构化 `data` 优先，其次结果正文本身就是 JSON 的情况。
fn tool_meta(output: &ToolOutput) -> Value {
    if output.data["_meta"].is_object() {
        return output.data["_meta"].clone();
    }
    serde_json::from_str::<Value>(&output.content)
        .ok()
        .map(|value| value["_meta"].clone())
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::ToolOutput;

    fn history() -> RunContext {
        RunContext::new(Default::default(), vec![], None, 0)
    }

    #[test]
    fn meta_is_read_from_structured_data_before_the_text_body() {
        let mut output = ToolOutput::text("{}".into());
        output.data = serde_json::json!({"_meta": {"zcode/nodeReplBrowserUse": true}});
        assert_eq!(tool_meta(&output)["zcode/nodeReplBrowserUse"], true);
        let text =
            ToolOutput::text(r#"{"_meta":{"zcode/nodeReplComputerUse":true},"content":[]}"#.into());
        assert_eq!(tool_meta(&text)["zcode/nodeReplComputerUse"], true);
        assert!(tool_meta(&ToolOutput::text("plain".into())).is_null());
    }

    #[test]
    fn applying_the_snapshot_sorts_and_copies_only() {
        let mut run = history();
        run.session_features.insert("tool_search_called".into());
        run.session_features.insert("browser_use".into());
        let mut options = ModelRequestOptions::default();
        apply(&run, &mut options);
        assert_eq!(
            options.session_features_header().as_deref(),
            Some("browser_use,tool_search_called")
        );
    }
}
