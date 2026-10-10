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
mod tests {
    use super::*;

    fn envelope(kind: &str, payload: Value) -> Value {
        json!({"commandId":"c1","clientId":"app","sessionId":"s","type":kind,"payload":payload,"issuedAt":1})
    }

    #[test]
    fn parse_command_returns_canonical_stripped_dto_and_numeric_revision() {
        let mut raw = envelope("setFollowupMode", json!({"mode":"queue","extra":true}));
        raw["baseRevision"] = json!(-1.5);
        raw["extraEnvelope"] = json!(true);
        let command = parse_command(&raw).unwrap();
        assert_eq!(command.base_revision, Some(-1.5));
        assert_eq!(command.payload, json!({"mode":"queue"}));
        let encoded = serde_json::to_value(command).unwrap();
        assert!(encoded.get("extraEnvelope").is_none());
        assert_eq!(encoded["sessionId"], "s");
    }

    #[test]
    fn parser_normalizes_nested_trim_paths_without_trimming_user_text() {
        let mut command = envelope(
            "sendText",
            json!({
                "text":"  preserve me  ",
                "modelSelection":{"providerId":"  provider  ","modelId":" model ","options":{"reasoningLevel":" deep "}}
            }),
        );
        command["baseLogEpoch"] = json!("  epoch-1  ");
        let parsed = parse_command(&command).unwrap();
        assert_eq!(parsed.base_log_epoch.as_deref(), Some("epoch-1"));
        assert_eq!(parsed.payload["text"], "  preserve me  ");
        assert_eq!(parsed.payload["modelSelection"]["providerId"], "provider");
        assert_eq!(parsed.payload["modelSelection"]["modelId"], "model");
        assert_eq!(
            parsed.payload["modelSelection"]["options"]["reasoningLevel"],
            "deep"
        );

        let mcp = envelope(
            "createSession",
            json!({
                "workspaceId":"workspace",
                "mcpServers":[{"name":" server ","command":" command ","args":[],"env":[{"name":" KEY ","value":"unchanged"}]}]
            }),
        );
        let parsed = parse_command(&mcp).unwrap();
        assert_eq!(parsed.payload["mcpServers"][0]["name"], "server");
        assert_eq!(parsed.payload["mcpServers"][0]["command"], "command");
        assert_eq!(parsed.payload["mcpServers"][0]["env"][0]["name"], "KEY");
        assert_eq!(
            parsed.payload["mcpServers"][0]["env"][0]["value"],
            "unchanged"
        );
    }

    #[test]
    fn parser_omits_absent_optional_fields_but_keeps_null_session() {
        let command = parse_command(&envelope("sendText", json!({"text":"x"}))).unwrap();
        let encoded = serde_json::to_value(command).unwrap();
        for key in ["ttft", "baseRevision", "baseLogEpoch"] {
            assert!(encoded.get(key).is_none(), "{key}");
        }
        let mut raw = envelope("createSession", json!({"workspaceId":"w"}));
        raw["sessionId"] = Value::Null;
        let encoded = serde_json::to_value(parse_command(&raw).unwrap()).unwrap();
        assert_eq!(encoded["sessionId"], Value::Null);
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
        // 这两个代表性 payload 在 TS 里显式 .strict()；测试范围不等于全集扫描。
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

    #[test]
    fn decodes_and_round_trips_live_typescript_oracle_fixtures() {
        use crate::{AckStatus, Command, CommandAck};

        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/ts-command-oracle.json")).unwrap();
        for case in fixture["commands"].as_array().unwrap() {
            let raw: Value = serde_json::from_str(case["raw"].as_str().unwrap()).unwrap();
            let result = parse_command(&raw);
            assert_eq!(
                result.is_ok(),
                case["ok"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if !result.is_ok() {
                continue;
            }
            let command = result.unwrap();
            let normalized = serde_json::to_value(&command).unwrap();
            let expected = &case["parsed"];
            assert!(
                crate::json_schema::js_json_equal(&normalized, expected),
                "{}",
                case["name"]
            );
            let decoded: Command = serde_json::from_value(normalized.clone()).unwrap();
            assert_eq!(decoded, command, "{}", case["name"]);
        }

        for case in fixture["acknowledgements"].as_array().unwrap() {
            let expected: Value = serde_json::from_str(case["raw"].as_str().unwrap()).unwrap();
            let decoded: CommandAck = serde_json::from_value(expected.clone()).unwrap();
            assert_eq!(decoded.status, AckStatus::Failed);
            let encoded = serde_json::to_value(&decoded).unwrap();
            assert!(crate::json_schema::js_json_equal(&encoded, &case["parsed"]));
            let round_trip: CommandAck = serde_json::from_value(encoded.clone()).unwrap();
            assert_eq!(round_trip, decoded);
            for field in ["reasonCode", "message", "memoryEnabled", "ttftExcluded"] {
                assert_eq!(encoded.get(field), expected.get(field), "{field}");
            }
        }
    }
}
