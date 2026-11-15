//! V4 command admission validation, equivalent to Node `parseCommandEnvelope`.
//!
//! `schema/v4-command.json` is generated from the TS zod contract by
//! `scripts/generate-zcode-cli-rust-protocol-schema.mjs` and checked for drift
//! in the test suite, so envelope and payload constraints have a single source.
//! Cross-field `superRefine` rules are not representable in JSON Schema and are
//! mirrored in [`refinements`].
//!
//! `sendText` 与 `discardSharedContext` 是本模块明确覆盖的 strict 示例；此列表不宣称
//! 穷举所有 strict payload。其余 payload 遵循各自 Zod schema 的未知字段策略。
use crate::json_schema::Node as Validator;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

const SCHEMA: &str = include_str!("../schema/v4-command.json");

struct Validators {
    envelope: Validator,
    payloads: HashMap<String, Validator>,
    requires_base_revision: HashSet<String>,
    requires_base_log_epoch: HashSet<String>,
}

fn validators() -> &'static Validators {
    static VALIDATORS: OnceLock<Validators> = OnceLock::new();
    VALIDATORS.get_or_init(|| {
        let schema: Value = serde_json::from_str(SCHEMA).expect("generated command schema is JSON");
        let compile = |schema: &Value| {
            Validator::compile(schema).expect("generated command schema uses the supported subset")
        };
        let names = |key: &str| {
            schema[key]
                .as_array()
                .expect("generated command schema lists")
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        };
        Validators {
            envelope: compile(&schema["envelope"]),
            payloads: schema["payloads"]
                .as_object()
                .expect("generated command payloads")
                .iter()
                .map(|(kind, schema)| (kind.clone(), compile(schema)))
                .collect(),
            requires_base_revision: names("requiresBaseRevision"),
            requires_base_log_epoch: names("requiresBaseLogEpoch"),
        }
    })
}

fn first_issue(validator: &Validator, value: &Value, path: &str) -> Option<String> {
    validator.validate(value, path).err()
}

/// 镜像 TS `sendText` 的 `superRefine`：JSON Schema 无法表达跨字段规则。
///
/// 与上游 ZCode-rs 的分叉：本仓库移除了闲时（OffPeak）执行，改为拒绝携带
/// `OffPeakCreate` 的 `toolDisallowlist`；`modelExecution` 依赖 `modelSelection` 两侧一致。
fn refinements(kind: &str, p: &Value) -> Result<(), String> {
    // 会话选区引用（上游 3.18.2 conversationQuotes）在 Rust 运行时没有材料渲染、持久化与
    // 投影 owner。接受命令却丢掉批注等于假支持，因此这里显式拒绝，由 Host 先按
    // runtime/capabilities.conversationQuotes 决定是否下发。
    if has_conversation_quotes(p) {
        return Err(
            "conversationQuotes: this Rust runtime does not support conversation selection quotes"
                .into(),
        );
    }
    // 受管 worktree 的 fork 目标 cwd（上游 3.18.2 `forkAssistant.targetCwd`）在 Rust 运行时
    // 没有 native 实现：不持久化子会话的 directory/path，也没有 `session/releaseUnderDirectory`。
    // `forkAssistant` 在 TS 侧不是 strict，schema 会接受并剥离该字段，命令随后会在父 cwd 里
    // 完成 fork——用户看到成功、目录却错了。因此这里显式拒绝，与 quotes 同一策略；
    // 去掉这条必须先交付真实语义，并把 runtime/capabilities.worktreeCwd 改为 true。
    if kind == "forkAssistant" && p.get("targetCwd").is_some() {
        return Err(
            "targetCwd: this Rust runtime does not support forking into another cwd".into(),
        );
    }
    if kind != "sendText" {
        return Ok(());
    }
    let present = |key: &str| p.get(key).is_some_and(|v| !v.is_null());
    let disallowlist_has_off_peak = p
        .get("toolDisallowlist")
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|v| v.as_str() == Some("OffPeakCreate")));
    if disallowlist_has_off_peak {
        return Err("(root): Idle-time execution is no longer supported".into());
    }
    if present("modelExecution") && !present("modelSelection") {
        return Err("modelExecution: modelExecution requires modelSelection".into());
    }
    Ok(())
}

/// `sendText` / `editUserQuery` / `editQueueItem` 的引用字段，以及 createSession.firstInput 的同名字段。
fn has_conversation_quotes(payload: &Value) -> bool {
    let non_empty = |value: Option<&Value>| {
        value
            .and_then(Value::as_array)
            .is_some_and(|q| !q.is_empty())
    };
    if non_empty(payload.get("conversationQuotes")) {
        return true;
    }
    payload
        .get("firstInput")
        .and_then(|first| first.get("conversationQuotes"))
        .and_then(Value::as_array)
        .is_some_and(|quotes| !quotes.is_empty())
}

/// Parse a raw `v4/command` envelope into the canonical Zod-compatible DTO.
pub fn parse_command(raw: &Value) -> Result<crate::Command, String> {
    let v = validators();
    let envelope = v.envelope.normalize(raw)?;
    if let Some(issue) = first_issue(&v.envelope, &envelope, "") {
        return Err(issue);
    }
    let kind = envelope["type"].as_str().unwrap_or_default();
    // 旧 Host 可能携带闲时续跑 commandId；判断使用 JS trim 的同一 schema 语义。
    if kind == "sendText"
        && zcode_cli_schema::js_trim_value(envelope["commandId"].as_str().unwrap_or_default())
            .starts_with("offpeak-")
    {
        return Err("commandId: Idle-time execution is no longer supported".into());
    }
    let payload_validator = v
        .payloads
        .get(kind)
        .ok_or_else(|| format!("type: unknown command {kind}"))?;
    let payload = payload_validator.normalize(&envelope["payload"])?;
    if let Some(issue) = first_issue(payload_validator, &payload, "payload") {
        return Err(issue);
    }
    refinements(kind, &payload)?;
    let missing = |key: &str| envelope.get(key).is_none_or(Value::is_null);
    if (v.requires_base_revision.contains(kind) && missing("baseRevision"))
        || (v.requires_base_log_epoch.contains(kind) && missing("baseLogEpoch"))
    {
        let field = if missing("baseRevision") {
            "baseRevision"
        } else {
            "baseLogEpoch"
        };
        return Err(format!(
            "{field}: CAS commands require baseRevision and baseLogEpoch"
        ));
    }
    let mut canonical = v.envelope.strip(&envelope);
    canonical["payload"] = payload_validator.strip(&payload);
    serde_json::from_value(canonical).map_err(|error| format!("command: {error}"))
}

/// Compatibility validation API; parsing and validation have a single owner.
pub fn validate_command(raw: &Value) -> Result<(), String> {
    parse_command(raw).map(|_| ())
}

/// ACK for a command that fails admission validation (Node `CommandInbox.handle`).
pub fn invalid_payload_ack(raw: &Value, message: &str) -> Value {
    json!({
        "commandId": raw["commandId"].as_str().unwrap_or(""),
        "status": "rejected",
        "reasonCode": "proto.invalidPayload",
        "message": message,
        "revisionAtDecision": 0,
    })
}

#[cfg(test)]
#[path = "command_schema_tests.rs"]
mod tests;
