//! Node 工具 part 的选择（`selectToolPartsForHistory` / `providerToolNameFromPart`）。
use serde_json::Value;

/// Node `selectToolPartsForHistory`: the last part per call id, in declaration
/// order when every part has one.
pub(super) fn tool_parts(parts: &[Value]) -> Vec<&Value> {
    let tools: Vec<&Value> = parts.iter().filter(|p| p["type"] == "tool").collect();
    let mut latest: Vec<&Value> = tools
        .iter()
        .enumerate()
        .filter(|(i, part)| {
            !tools[i + 1..]
                .iter()
                .any(|later| later["callID"] == part["callID"])
        })
        .map(|(_, part)| *part)
        .collect();
    // 任一 part 缺声明序号（旧记录或混合版本）时整组保留原序。
    if latest.iter().all(|p| p.get("declarationIndex").is_some()) {
        latest.sort_by_key(|p| p["declarationIndex"].as_i64().unwrap_or(0));
    }
    latest
}

/// Node `providerToolNameFromPart`.
pub(super) fn tool_name(part: &Value) -> Value {
    match part["metadata"].get("providerToolName") {
        Some(Value::String(name)) => name.as_str().into(),
        _ => part["tool"].clone(),
    }
}
