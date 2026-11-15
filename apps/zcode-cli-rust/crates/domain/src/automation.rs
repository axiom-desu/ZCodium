//! Node `CronPauseSelf`（3.18 F14）：暂停“触发本轮的那条 automation”。
//!
//! 目标身份只来自 Host 准入注入的本轮 `automationId`，不接受任何模型输入：provider schema 是
//! 严格空对象，handler 先判定身份再解析输入。定义/权限/文案对齐
//! `apps/zcode-cli/packages/core/src/tool/handlers/cron-pause-self.ts` 与
//! `packages/contracts/src/tools/automation.ts`（本仓 TS 是行为事实源）。
use serde_json::{Value, json};

pub const PAUSE_SELF: &str = "CronPauseSelf";
/// Node `cronPermission("automation.pause", …, false)` 的权限键。
pub const PAUSE_SELF_PERMISSION: &str = "automation.pause";
/// Node `CRON_MODEL_BYTES`：`cronResultBudget` 的截断上限。
pub const PAUSE_SELF_MAX_BYTES: usize = 32_000;
pub const ERROR_NO_AUTOMATION: &str =
    "CronPauseSelf is only available while running a scheduled automation.";
/// 旧 Host 的 `-32601` 与 automationOwner 拒绝的 `-32602` 在传输层都投影成空回执，
/// 因此“没有结论”与“Host 不支持/拒绝”共用同一条显式失败，绝不返回假成功。
pub const ERROR_REJECTED: &str =
    "automation/pause was rejected or failed on the Host; the automation was not paused";
pub const ERROR_CANCELLED: &str = "CronPauseSelf was cancelled before the automation was paused";

const DESCRIPTION: &str = "Pause the scheduled automation that triggered the current run so it stops running on schedule until the user resumes it. It only targets the automation of this run, takes no input, and cannot change the automation definition.";

/// Provider definition (same shape the Node entry publishes).
pub fn pause_self_definition() -> Value {
    json!({"type":"function","function":{
        "name":PAUSE_SELF,
        "description":DESCRIPTION,
        "parameters":pause_self_parameters()}})
}

pub fn pause_self_parameters() -> Value {
    json!({"type":"object","properties":{},"additionalProperties":false,
        "$schema":"https://json-schema.org/draft/2020-12/schema"})
}

pub fn pause_self_output_parameters() -> Value {
    json!({"type":"object","properties":{
            "paused":{"type":"boolean"},
            "id":{"type":"string","minLength":1},
            "message":{"type":"string","minLength":1}},
        "required":["paused","id","message"],"additionalProperties":false,
        "$schema":"https://json-schema.org/draft/2020-12/schema"})
}

/// Host-admitted automation id of this run: only the trusted submission value
/// counts, so an empty/whitespace id is no id at all.
pub fn admitted_id(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|id| !id.is_empty())
}

/// Strict empty input: any key (including a forged `automationId`) is a definite
/// argument failure, never a target. Mirrors `CronPauseSelfInputSchema`.
pub fn validate_input(args: &Value) -> Result<(), String> {
    let Some(object) = args.as_object() else {
        return Err("CronPauseSelf input must be an object".into());
    };
    if let Some(key) = object.keys().next() {
        return Err(format!(
            "Unrecognized key(s) in CronPauseSelf input: '{key}'. It takes no input."
        ));
    }
    Ok(())
}

/// Strict `CronPauseSelfOutputSchema` / `zcodeAutomationPauseResultSchema` reply:
/// only `{paused: boolean}` is a conclusion. A missing reply (the protocol drops
/// Host error bodies, e.g. `-32601`/`-32602`) is not `false`; it is a failure.
pub fn parse_pause(reply: &Value) -> Result<bool, String> {
    let Some(object) = reply.as_object() else {
        return Err(ERROR_REJECTED.into());
    };
    match (object.len(), object.get("paused")) {
        (1, Some(Value::Bool(paused))) => Ok(*paused),
        _ => Err(ERROR_REJECTED.into()),
    }
}

/// Model-visible result of a successful Host conclusion.
pub fn pause_result(id: &str, paused: bool) -> (String, Value) {
    let message = if paused {
        format!("Paused automation {id}. It will not run on schedule until the user resumes it.")
    } else {
        format!(
            "Automation {id} is not active (already paused, completed, failed, or deleted), so nothing changed."
        )
    };
    let data = json!({"paused":paused,"id":id,"message":message});
    (message, data)
}

#[cfg(test)]
#[path = "automation_tests.rs"]
mod tests;
