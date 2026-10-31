//! Post-failure guidance only; validation remains with the original input owners.
use super::tool_search::SearchContext;
use crate::contract::{InputValidationError, ToolOutput};
use crate::domain::tool_search::{ResolvedMode, definition_name};

// 3c5b2276 call-runner.ts：完整解释原文，不能把执行/网络失败猜成参数失败。
const EXPLANATION: &str = "\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ";

pub(super) fn append(
    output: &mut ToolOutput,
    error: Option<&anyhow::Error>,
    search: Option<&SearchContext>,
    name: &str,
) {
    if !error.is_some_and(|error| error.is::<InputValidationError>()) {
        return;
    }
    output.error = Some(("InputValidationError", "input_validation_failed"));
    let Some(search) = search.filter(|search| {
        search.enabled
            && !search.discovered.contains(name)
            && search
                .catalog
                .iter()
                .any(|tool| tool.name == name && tool.deferred)
    }) else {
        return;
    };
    let Some(definition) = search
        .definitions
        .iter()
        .find(|tool| definition_name(tool) == name)
    else {
        return;
    };
    let schema = crate::domain::js_json::stringify(&definition["function"]["parameters"]);
    // 失败结果只有一个文本出口：模型与 UI/持久 part 读同一原因及纠错提示。
    output.content.push_str(EXPLANATION);
    output.content.push_str(&format!(
        "Load the tool first: call ToolSearch with query \"select:{name}\", then retry this call. For reference, this tool's input schema is: {schema}"
    ));
    if search.mode == ResolvedMode::Local {
        output.content.push_str(&format!(
            "\nCall DeferredToolCall with {{name: \"{name}\", input: {{...}}}}."
        ));
    }
}
