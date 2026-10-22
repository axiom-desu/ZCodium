//! 命令分发的 fake transport 回归：断言发往 actor 的精确请求与失败后的原投影。
use crate::{
    client::Client,
    command_dispatch,
    projection::View,
    projection_tests::{request, view},
};
use anyhow::Result;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, Method, RuntimeError, ServerMsg};

/// 只接收一个请求并校验，然后按给定结果回复。
type Endpoints = (mpsc::Sender<ClientMsg>, mpsc::Receiver<Vec<ServerMsg>>);

fn once<F>(check: F, reply: Value) -> (Endpoints, tokio::task::JoinHandle<()>)
where
    F: FnOnce(Method, &Value) + Send + 'static,
{
    let (to, mut input) = mpsc::channel(4);
    let (output, from) = mpsc::channel(4);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request {
            token,
            method,
            params,
        } = input.recv().await.expect("expected one request")
        else {
            panic!("expected a request message")
        };
        check(method, &params);
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(reply),
            }])
            .await
            .unwrap();
    });
    ((to, from), actor)
}

fn snapshot_with(thought: &str, levels: Value, mode: &str) -> Value {
    json!({"sessionId":"s","seq":0,"rows":{"window":[]},"control":{"canStop":false},
        "config":{"mode":mode,"thought":thought,"thoughtLevels":levels},
        "pendingInteractions":[]})
}

async fn dispatch_no_actor(v: &mut View, text: &str) -> (Result<bool>, bool) {
    let (to, mut input) = mpsc::channel(4);
    let (_output, mut from) = mpsc::channel(4);
    let mut c = Client::new(&to, &mut from);
    let result = command_dispatch::dispatch(&mut c, v, &request(), text).await;
    (result, input.try_recv().is_err())
}

#[tokio::test]
async fn idle_compact_sends_one_canonical_sendtext_without_attachments() {
    let ((to, mut from), actor) = once(
        |method, params| {
            assert_eq!(method, Method::Command);
            // 不能发 type "compact"：共享 schema 的 compact payload 是 z.object({})，
            // 真实 parse_command 会把 payload.text strip 掉。
            assert_eq!(params["type"], "sendText");
            assert_eq!(params["payload"]["text"], "/compact keep  the\ndetails");
            assert!(params["payload"].get("attachments").is_none());
            assert!(params["payload"].get("toolDisallowlist").is_none());
            // 走真实协议解析：指令必须原样穿过 v4 schema，再由 core 归一化成 compact。
            let parsed = zcode_cli_protocol::parse_command(params)
                .expect("canonical sendText 必须通过真实协议解析");
            assert_eq!(parsed.kind, "sendText");
            assert_eq!(
                parsed.payload["text"].as_str().unwrap_or("?").trim(),
                "/compact keep  the\ndetails"
            );
        },
        json!({"status":"accepted"}),
    );
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    let result = command_dispatch::dispatch(
        &mut c,
        &mut v,
        &request(),
        "/compress   keep  the\ndetails  ",
    )
    .await;
    actor.await.unwrap();
    assert!(!result.unwrap());
    assert!(v.rows.is_empty());
    assert!(v.notices.is_empty());
    assert!(!v.pending_submit);
}

#[test]
fn compact_type_payload_text_is_stripped_by_the_real_schema() {
    // 缺陷取证（修复前实现的红用例）：直接发 type "compact" + payload.text 时，
    // parse_command 按 zod strip 语义丢掉附加指令，模型永远收不到 instructions。
    let raw = json!({
        "commandId":"c1","clientId":"zcode-cli-tui","sessionId":"s",
        "type":"compact","payload":{"text":"keep  the\ndetails"},"issuedAt":0
    });
    let parsed = zcode_cli_protocol::parse_command(&raw).expect("compact 信封本身是合法的");
    assert_eq!(parsed.kind, "compact");
    assert!(
        parsed.payload.get("text").is_none(),
        "compact payload 是 z.object({{}})，text 会在 schema 层被 strip：{:?}",
        parsed.payload
    );
}

#[tokio::test]
async fn rejected_compact_ack_creates_no_marker_or_state() {
    let ((to, mut from), actor) = once(
        |method, params| {
            assert_eq!(method, Method::Command);
            assert_eq!(params["payload"]["text"], "/compact");
        },
        json!({"status":"rejected","reasonCode":"busy"}),
    );
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    let error = command_dispatch::dispatch(&mut c, &mut v, &request(), "/compact")
        .await
        .unwrap_err();
    actor.await.unwrap();
    assert!(error.to_string().contains("busy"));
    assert!(v.rows.is_empty());
    assert!(!v.pending_submit);
    assert_eq!(v.session, "s");
}

#[tokio::test]
async fn misspelled_or_unknown_slash_is_local_and_never_reaches_the_actor() {
    for text in ["/compactfoo hi", "/nope", "/effort", "/help mcp"] {
        let mut v = view();
        let (result, idle) = dispatch_no_actor(&mut v, text).await;
        assert!(result.is_err(), "{text} must be a local error");
        assert!(idle, "{text} must not send anything to the actor");
        assert!(v.rows.is_empty());
    }
}

#[tokio::test]
async fn effort_lists_actor_levels_without_a_request() {
    let mut v = view();
    v.state["config"]["thought"] = "high".into();
    v.state["config"]["thoughtLevels"] = json!(["low", "high"]);
    let (result, idle) = dispatch_no_actor(&mut v, "/variant list").await;
    assert!(!result.unwrap());
    assert!(idle);
    let notice = v.notices.last().unwrap();
    assert!(notice.contains("high") && notice.contains("low"));
}

#[tokio::test]
async fn effort_set_sends_canonical_level_and_shows_refreshed_snapshot() {
    let (to, mut input) = mpsc::channel(4);
    let (output, mut from) = mpsc::channel(4);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request {
            token,
            method,
            params,
        } = input.recv().await.unwrap()
        else {
            panic!()
        };
        assert_eq!(method, Method::SessionSetThoughtLevel);
        assert_eq!(params["thoughtLevel"], "High");
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(json!({})),
            }])
            .await
            .unwrap();
        let ClientMsg::Request { token, method, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(method, Method::TopicSnapshot);
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(json!({"snapshot":snapshot_with("High", json!(["low", "High", "max"]), "build")})),
            }])
            .await
            .unwrap();
    });
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    v.state["config"]["thoughtLevels"] = json!(["low", "High", "max"]);
    command_dispatch::dispatch(&mut c, &mut v, &request(), "/effort high")
        .await
        .unwrap();
    actor.await.unwrap();
    assert_eq!(v.state["config"]["thought"], "High");
}

#[tokio::test]
async fn rejected_effort_setter_keeps_previous_facts() {
    let (to, mut input) = mpsc::channel(4);
    let (output, mut from) = mpsc::channel(4);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request { token, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Err(RuntimeError::InvalidParams("unsupported".into())),
            }])
            .await
            .unwrap();
    });
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    v.state["config"]["thought"] = "low".into();
    v.state["config"]["thoughtLevels"] = json!(["low", "high"]);
    assert!(
        command_dispatch::dispatch(&mut c, &mut v, &request(), "/variant high")
            .await
            .is_err()
    );
    actor.await.unwrap();
    assert_eq!(v.state["config"]["thought"], "low");
    assert!(v.rows.is_empty());
}

#[tokio::test]
async fn mode_command_keeps_the_existing_setter_path() {
    let (to, mut input) = mpsc::channel(4);
    let (output, mut from) = mpsc::channel(4);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request {
            token,
            method,
            params,
        } = input.recv().await.unwrap()
        else {
            panic!()
        };
        assert_eq!(method, Method::SessionSetMode);
        assert_eq!(params["mode"], "edit");
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(json!({})),
            }])
            .await
            .unwrap();
        let ClientMsg::Request { token, method, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(method, Method::TopicSnapshot);
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(json!({"snapshot":snapshot_with("low", json!(["low"]), "edit")})),
            }])
            .await
            .unwrap();
    });
    let mut c = Client::new(&to, &mut from);
    let mut v = view();
    command_dispatch::dispatch(&mut c, &mut v, &request(), "/mode edit")
        .await
        .unwrap();
    actor.await.unwrap();
    assert_eq!(v.state["config"]["mode"], "edit");
}

#[tokio::test]
async fn help_lists_implemented_commands_only() {
    let mut v = view();
    let (result, idle) = dispatch_no_actor(&mut v, "/help").await;
    assert!(!result.unwrap());
    assert!(idle);
    let notice = v.notices.last().unwrap();
    assert!(notice.contains("/compact [instructions]"));
    assert!(notice.contains("/effort [list|<level>]"));
    assert!(!notice.contains("/mcp"));

    let mut v = view();
    let (result, idle) = dispatch_no_actor(&mut v, "/help compact").await;
    assert!(!result.unwrap());
    assert!(idle);
    assert!(
        v.notices
            .last()
            .unwrap()
            .contains("/compact [instructions]")
    );
}

#[tokio::test]
async fn quit_still_returns_the_exit_flag_locally() {
    let mut v = view();
    let (result, idle) = dispatch_no_actor(&mut v, "/exit").await;
    assert!(result.unwrap());
    assert!(idle);
    assert!(v.notices.is_empty());
}

#[tokio::test]
async fn blank_thought_levels_are_not_valid_levels_and_never_hit_the_actor() {
    // actor 在无档位时会给出 [""]；空字符串/纯空白不是档位，不能被广告或提交。
    for levels in [json!([""]), json!(["  ", "\t"]), json!(["", " "])] {
        let mut v = view();
        v.state["config"]["thoughtLevels"] = levels.clone();

        let (result, idle) = dispatch_no_actor(&mut v, "/effort").await;
        assert!(result.is_err(), "{levels} 列表必须报 no-level 错误");
        assert!(idle, "{levels} 不得调用 actor");

        let (result, idle) = dispatch_no_actor(&mut v, "/effort low").await;
        assert!(result.is_err(), "{levels} 设置必须报 no-level 错误");
        assert!(idle, "{levels} 设置不得调用 actor");
        assert!(v.rows.is_empty());
    }
}
