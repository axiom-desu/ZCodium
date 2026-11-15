//! `command_schema` 的准入回归测试。
//! 内容与拆分前逐字一致，只为把源文件保持在 400 行上限内。

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
    assert!(validate_command(&envelope("setFollowupMode", json!({"mode":"x","extra":1}))).is_err());
    // setFollowupMode 属 CAS 命令（requiresBaseRevision），必须带 baseRevision。
    let mut followup = envelope("setFollowupMode", json!({"mode":"queue"}));
    followup["baseRevision"] = json!(3);
    assert!(validate_command(&followup).is_ok());
    assert!(validate_command(&envelope("sendText", json!({"text":1}))).is_err());
    assert!(validate_command(&envelope("nope", json!({}))).is_err());
    let missing_revision = validate_command(&envelope("setAutoDrain", json!({"autoDrain":true})));
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
fn conversation_quotes_are_explicitly_unsupported() {
    // 本运行时不渲染引用材料：携带批注必须显式失败，而不是“成功但批注消失”。
    let quotes = json!([{"text":"quoted","comment":"why?"}]);
    // edit / 队列编辑在生成 schema 里不是 strict，未加判定时会被静默剥离，这里必须失败。
    let mut edit = envelope(
        "editUserQuery",
        json!({"target":{"rowId":1,"entityId":"e"},"newText":"x","conversationQuotes":quotes}),
    );
    edit["baseRevision"] = json!(1);
    edit["baseLogEpoch"] = json!("epoch-1");
    let err = validate_command(&edit).unwrap_err();
    assert!(err.contains("conversationQuotes"), "{err}");
    let mut queue = envelope(
        "editQueueItem",
        json!({"queueItemId":"q","newText":"x","conversationQuotes":quotes}),
    );
    queue["baseRevision"] = json!(1);
    let err = validate_command(&queue).unwrap_err();
    assert!(err.contains("conversationQuotes"), "{err}");
    let err = validate_command(&envelope(
        "createSession",
        json!({"workspaceId":"w","firstInput":{"text":"x","conversationQuotes":quotes}}),
    ))
    .unwrap_err();
    assert!(err.contains("conversationQuotes"), "{err}");
    // sendText 是 strict：无论判定来自 schema 未知字段还是本模块的显式拒绝，都必须失败。
    assert!(
        validate_command(&envelope(
            "sendText",
            json!({"text":"x","conversationQuotes":quotes})
        ))
        .is_err()
    );
    // 空数组等同没有引用：不改变普通编辑语义。
    let mut empty = envelope(
        "editUserQuery",
        json!({"target":{"rowId":1,"entityId":"e"},"newText":"x","conversationQuotes":[]}),
    );
    empty["baseRevision"] = json!(1);
    empty["baseLogEpoch"] = json!("epoch-1");
    assert!(validate_command(&empty).is_ok());
}

#[test]
fn fork_target_cwd_is_schema_legal_but_explicitly_unsupported() {
    // 生成物与本仓 shared wire 一致：schema 接受 `targetCwd` 并声明两条 trim 路径，
    // 所以拒绝只能来自 refinements，而不是 schema 不认识字段后静默剥离。
    let payload = json!({
        "target":{"rowId":1,"entityId":"  e  "},
        "targetCwd":{"cwd":"  /tmp/managed-worktree  ","childSessionId":"  child-1  "}
    });
    let schema = &validators().payloads["forkAssistant"];
    let normalized = schema.normalize(&payload).expect("payload normalizes");
    assert!(schema.validate(&normalized, "payload").is_ok());
    assert_eq!(
        schema.strip(&normalized)["targetCwd"],
        json!({"cwd":"/tmp/managed-worktree","childSessionId":"child-1"})
    );

    // 准入必须显式失败：接受却在父 cwd 里 fork 等于假支持。
    let mut target_cwd = envelope("forkAssistant", payload);
    target_cwd["baseRevision"] = json!(3);
    target_cwd["baseLogEpoch"] = json!("epoch-1");
    let err = validate_command(&target_cwd).unwrap_err();
    assert!(err.contains("targetCwd"), "{err}");

    // 普通 fork（不带 targetCwd）语义不变。
    let mut plain = envelope(
        "forkAssistant",
        json!({"target":{"rowId":1,"entityId":"e"}}),
    );
    plain["baseRevision"] = json!(3);
    plain["baseLogEpoch"] = json!("epoch-1");
    assert!(validate_command(&plain).is_ok());
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
