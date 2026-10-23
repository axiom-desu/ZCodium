use crate::{
    interactions,
    projection::View,
    transport::{Request, Resume},
};
use serde_json::{Value, json};
use zcode_cli_core_api::{RuntimeEvent, ServerMsg};

fn snapshot() -> Value {
    json!({"sessionId":"s","seq":0,"rows":{"window":[]},"control":{"canStop":false},"config":{"mode":"build"},"pendingInteractions":[]})
}
pub(super) fn view() -> View {
    let mut v = View::default();
    v.snapshot(&snapshot());
    v
}
pub(super) fn delta(from: u64, to: u64, value: Value) -> ServerMsg {
    ServerMsg::Event(RuntimeEvent::ConversationDeltas {
        session: "s".into(),
        from,
        to,
        deltas: zcode_cli_domain::topic_log::sized(vec![value]),
        ttft: vec![],
    })
}
pub(super) fn request() -> Request {
    Request {
        workspace: json!({"workspacePath":"/tmp/test"}),
        directory: "/tmp/test".into(),
        mode_override: None,
        resume: Resume::New,
        disallowed_tools: vec![],
        attachments: vec![],
        locale: "en-US".into(),
    }
}

#[test]
fn snapshot_restores_canonical_history_and_busy_state() {
    let mut v = view();
    let mut s = snapshot();
    s["rows"]["window"] = json!([{"rowId":"r","kind":"assistantText","text":"previous answer"}]);
    s["control"]["canStop"] = true.into();
    v.snapshot(&s);
    assert!(v.busy());
    assert!(v.lines().iter().any(|s| s.contains("previous answer")));
}
#[test]
fn streaming_updates_the_row_not_the_last_tool_line() {
    let mut v = view();
    v.deltas(
        "s",
        0,
        1,
        vec![
            json!({"op":"row.appended","row":{"rowId":"a","kind":"assistantText","text":"first"}}),
        ]
        .into_iter(),
    );
    v.deltas(
        "s",
        1,
        2,
        vec![json!({"op":"row.appended","row":{"rowId":"t","kind":"toolCall","toolName":"Read"}})]
            .into_iter(),
    );
    v.deltas(
        "s",
        2,
        3,
        vec![json!({"op":"row.delta","rowId":"a","path":"text","append":" second"})].into_iter(),
    );
    assert_eq!(v.rows[0]["text"], "first second");
    assert!(v.rows[1].get("text").is_none());
}
#[test]
fn long_streams_are_bounded_and_errors_and_cancellation_remain_visible() {
    let mut v = view();
    v.deltas(
        "s",
        0,
        1,
        std::iter::once(
            json!({"op":"row.appended","row":{"rowId":"a","kind":"assistantText","text":"x"}}),
        ),
    );
    v.deltas(
        "s",
        1,
        2,
        std::iter::once(json!({"op":"row.delta","rowId":"a","path":"text","append":format!("{}🙂", "y".repeat(40_000))})),
    );
    assert!(v.rows[0]["text"].as_str().unwrap().len() <= crate::projection::MAX_FIELD_BYTES);
    assert!(
        v.rows[0]["text"]
            .as_str()
            .unwrap()
            .contains("display truncated")
    );
    v.state["control"]["lastError"]["message"] = "visible failure".into();
    v.state["control"]["phase"] = "completedInterrupted".into();
    let rendered = v.lines().join("\\n");
    assert!(rendered.contains("visible failure"));
    assert!(rendered.contains("Turn cancelled"));
    assert!(rendered.len() <= crate::projection::MAX_RENDER_BYTES);
}

#[test]
fn latest_rows_and_errors_survive_large_history_with_bounded_rendering() {
    let mut v = view();
    let mut s = snapshot();
    s["rows"]["window"] = json!(
        (0..200)
            .map(|i| json!({
                "rowId": format!("old-{i}"),
                "kind": "assistantText",
                "text": "old history ".repeat(16_000)
            }))
            .collect::<Vec<_>>()
    );
    s["rows"]["window"].as_array_mut().unwrap().push(json!({
        "rowId": "latest", "kind": "assistantText", "text": "new marker"
    }));
    s["control"]["lastError"]["message"] = "latest failure".into();
    v.snapshot(&s);
    assert!(v.state.get("rows").is_none());

    let rendered = v.lines().join("\\n");
    assert!(rendered.contains("new marker"));
    assert!(rendered.contains("latest failure"));
    assert!(rendered.len() <= crate::projection::MAX_RENDER_BYTES);
}

#[test]
fn stale_sessions_and_sequences_are_ignored_but_gaps_request_snapshot() {
    let mut v = view();
    v.deltas(
        "other",
        0,
        1,
        std::iter::once(json!({"op":"row.appended","row":{"rowId":"bad"}})),
    );
    assert_eq!(v.seq, 0);
    v.deltas("s", 1, 2, std::iter::empty());
    assert!(v.resync);
    assert_eq!(v.seq, 0);
    v.snapshot(&snapshot());
    v.deltas("s", 0, 1, std::iter::empty());
    v.deltas(
        "s",
        0,
        1,
        std::iter::once(json!({"op":"row.appended","row":{"rowId":"stale"}})),
    );
    assert!(v.rows.is_empty());
}
#[test]
fn committed_state_replaces_permissions_by_id_without_guessing_last_prompt() {
    let mut v = view();
    v.deltas("s",0,1,std::iter::once(json!({"op":"state.updated","patch":{"pendingInteractions":[{"interactionId":"one"},{"interactionId":"two"}]}})));
    assert_eq!(v.interaction().unwrap()["interactionId"], "one");
    v.deltas(
        "s",
        1,
        2,
        std::iter::once(
            json!({"op":"state.updated","patch":{"pendingInteractions":[{"interactionId":"two"}]}}),
        ),
    );
    assert_eq!(v.interaction().unwrap()["interactionId"], "two");
}
#[test]
fn permission_uses_only_offered_option_ids_and_never_auto_approves() {
    let p = json!({"kind":"permission","payload":{"options":[{"optionId":"allowOnce","label":"Allow once"},{"optionId":"deny","label":"Deny"}]}});
    assert_eq!(
        interactions::answer(&p, "yes").unwrap(),
        json!({"optionId":"allowOnce"})
    );
    assert_eq!(
        interactions::answer(&p, "n").unwrap(),
        json!({"optionId":"deny"})
    );
    assert!(interactions::answer(&p, "").is_err());
    assert!(interactions::answer(&p, "fullAccess").is_err());
}
#[test]
fn questions_use_the_selected_interaction_question_names() {
    let q = json!({"kind":"userInput","interactionId":"q1","payload":{"input":{"questions":[{"question":"Which?","options":[{"label":"A"}]},{"question":"Why?"}]}}});
    assert_eq!(
        interactions::answer(&q, "A\n理由").unwrap(),
        json!({"action":"accept","content":{"answers":{"Which?":"A","Why?":"理由"}}})
    );
    assert!(interactions::answer(&q, "A").is_err());
    assert!(interactions::prompt(&q).contains("Which?"));
}

/// 严格快照 source guard：畸形空快照/同会话 seq 倒退不得擦 View；同会话保滚动与 pending。
#[test]
fn snapshot_guard_rejects_malformed_or_stale_replies_and_preserves_scroll() {
    use crate::operations::{OpKind, SentDraft};
    let mut v = view();
    v.operations
        .begin(
            OpKind::Submit,
            "s",
            v.generation,
            Some(SentDraft::default()),
        )
        .unwrap();
    v.pending_submit = true;
    v.follow = false;
    v.scroll = 11;
    let rows = v.rows.clone();
    assert!(!v.snapshot(&json!({})), "空 object 不得擦全 View");
    assert!(!v.snapshot(&json!({"sessionId":"","seq":1,"rows":{"window":[]}})));
    assert_eq!(v.rows, rows);
    assert_eq!(v.session, "s");
    let mut same = snapshot();
    same["seq"] = 1.into();
    assert!(v.snapshot(&same));
    assert!(v.pending_submit, "同会话快照保留真实在飞 overlay");
    assert!(!v.follow);
    assert_eq!(v.scroll, 11);
    assert!(!v.snapshot(&json!({"sessionId":"s","seq":0,"rows":{"window":[]}})));
    // 显式新会话才重置滚动与 pending。
    assert!(v.snapshot(&json!({"sessionId":"s2","seq":0,"rows":{"window":[]}})));
    assert!(v.follow);
    assert_eq!(v.scroll, 0);
    assert!(!v.pending_submit);
}

/// owner reset 同会话新 logEpoch 可重排 seq：不能当迟到回包拒绝；普通快照仍守 FIFO。
#[test]
fn same_session_owner_reset_with_new_epoch_may_rewind_seq() {
    let mut v = view();
    v.seq = 9;
    v.state["logEpoch"] = json!("epoch-2");
    let reset = json!({"sessionId":"s","seq":2,"logEpoch":"epoch-3","rows":{"window":[]},
        "control":{"canStop":false},"config":{"mode":"build"},"pendingInteractions":[]});
    assert!(v.reset_snapshot(&reset));
    assert_eq!(v.seq, 2);
    assert_eq!(v.state["logEpoch"], "epoch-3");
    assert!(!v.snapshot(&json!({"sessionId":"s","seq":1,"rows":{"window":[]}})));
}
