//! V4 command admission validation, equivalent to Node `parseCommandEnvelope`.
//!
//! `schema/v4-command.json` is generated from the TS zod contract by
//! `scripts/generate-zcode-cli-rust-protocol-schema.mjs` and checked for drift
//! in the test suite, so envelope and payload constraints have a single source.
//! Cross-field `superRefine` rules are not representable in JSON Schema and are
//! mirrored in [`refinements`].
//!
//! 契约分叉注意：本仓库的 `sendText` 是 `.strict()`（拒绝未知字段），而
//! `discardSharedContext` 同样 strict；其余命令沿用 zod 默认的剥离语义。
//! 新增 `.strict()` 命令时必须同步更新 `strict_commands` 测试。
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

/// Validate a raw `v4/command` envelope and its payload. Returns the first issue.
pub fn validate_command(raw: &Value) -> Result<(), String> {
    let v = validators();
    if let Some(issue) = first_issue(&v.envelope, raw, "") {
        return Err(issue);
    }
    let kind = raw["type"].as_str().unwrap_or_default();
    let payload = raw.get("payload").unwrap_or(&Value::Null);
    let validator = v
        .payloads
        .get(kind)
        .ok_or_else(|| format!("type: unknown command {kind}"))?;
    if let Some(issue) = first_issue(validator, payload, "payload") {
        return Err(issue);
    }
    refinements(kind, payload)?;
    let missing = |key: &str| raw.get(key).is_none_or(Value::is_null);
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
    Ok(())
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
mod tests {
    use super::*;

    fn envelope(kind: &str, payload: Value) -> Value {
        json!({"commandId":"c1","clientId":"app","sessionId":"s","type":kind,"payload":payload,"issuedAt":1})
    }

    #[test]
    fn every_generated_command_compiles() {
        assert_eq!(validators().payloads.len(), 34);
    }

    #[test]
    fn accepts_valid_and_rejects_invalid_payloads_like_node() {
        assert!(validate_command(&envelope("sendText", json!({"text":"hi"}))).is_ok());
        // 本仓库 sendText 是 .strict()：未知字段被 zod 拒绝，而非静默剥离。
        assert!(validate_command(&envelope("sendText", json!({"text":"hi","extra":1}))).is_err());
        // 非 strict 命令保持 zod 默认语义：未知字段被接受（Node 解析时剥离）。
        assert!(
            validate_command(&envelope("setFollowupMode", json!({"mode":"x","extra":1}))).is_err()
        );
        // setFollowupMode 属 CAS 命令（requiresBaseRevision），必须带 baseRevision。
        let mut followup = envelope("setFollowupMode", json!({"mode":"queue"}));
        followup["baseRevision"] = json!(3);
        assert!(validate_command(&followup).is_ok());
        assert!(validate_command(&envelope("sendText", json!({"text":1}))).is_err());
        assert!(validate_command(&envelope("nope", json!({}))).is_err());
        let missing_revision =
            validate_command(&envelope("setAutoDrain", json!({"autoDrain":true})));
        assert!(missing_revision.unwrap_err().starts_with("baseRevision:"));
    }

    #[test]
    fn strict_commands_reject_unknown_fields() {
        // sendText 与 discardSharedContext 在 TS 里显式 .strict()。
        assert!(validate_command(&envelope("sendText", json!({"text":"x","junk":1}))).is_err());
        assert!(
            validate_command(&envelope(
                "discardSharedContext",
                json!({"contextId":"c","junk":1})
            ))
            .is_err()
        );
    }

    #[test]
    fn mirrors_send_text_refinements() {
        let execution = json!({"text":"x","modelExecution":{"selectionScope":"execution"}});
        assert!(validate_command(&envelope("sendText", execution)).is_err());
        // 闲时执行已移除：携带 OffPeakCreate 的 toolDisallowlist 必须被拒绝。
        let off_peak = json!({"text":"x","toolDisallowlist":["OffPeakCreate"]});
        let err = validate_command(&envelope("sendText", off_peak)).unwrap_err();
        assert!(
            err.contains("Idle-time execution is no longer supported"),
            "{err}"
        );
    }

    #[test]
    fn envelope_accepts_optional_ttft_context() {
        // 本仓库 envelope 有 ttft（localTtftContextSchema.optional()），Rust 侧必须放行。
        let mut raw = envelope("sendText", json!({"text":"hi"}));
        raw["ttft"] = json!({
            "version": 1,
            "observationId": "01890a5d-ac96-774b-bcce-b302099a8057"
        });
        assert!(validate_command(&raw).is_ok());
    }

    #[test]
    fn invalid_ack_matches_node_shape() {
        let ack = invalid_payload_ack(&json!({"commandId":7}), "bad");
        assert_eq!(
            ack,
            json!({"commandId":"","status":"rejected","reasonCode":"proto.invalidPayload","message":"bad","revisionAtDecision":0})
        );
    }
}
