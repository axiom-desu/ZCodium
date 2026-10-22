//! Fake-transport regression tests for the complete Enter dispatch path.
//!
//! 这些测试使用真实 [`Client`] 与同一 mpsc 契约，只把 runtime 换成预置回包，
//! 因而验证的是 submit_editor → enter → command_dispatch 的完整路由，
//! 而不是另写一份 parser 断言。
use crate::{
    client::Client,
    projection::View,
    transport::{Request, Resume, submit_editor},
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, ServerMsg};

fn request() -> Request {
    Request {
        workspace: json!({"path":"/workspace"}),
        directory: "/workspace".into(),
        mode_override: None,
        resume: Resume::New,
        disallowed_tools: Vec::new(),
        attachments: Vec::new(),
        locale: "en".into(),
    }
}

fn view() -> View {
    View {
        session: "s1".into(),
        directory: "/workspace".into(),
        ..View::default()
    }
}

/// 预置 runtime 回包（按 token 1..n），返回收发两端。
async fn harness(
    replies: Vec<Value>,
) -> (
    mpsc::Sender<ClientMsg>,
    mpsc::Receiver<Vec<ServerMsg>>,
    mpsc::Receiver<ClientMsg>,
) {
    let (to, requests) = mpsc::channel(8);
    let (responses, from) = mpsc::channel(8);
    if !replies.is_empty() {
        responses
            .send(
                replies
                    .into_iter()
                    .enumerate()
                    .map(|(index, result)| ServerMsg::Reply {
                        token: index as u64 + 1,
                        result: Ok(result),
                    })
                    .collect(),
            )
            .await
            .unwrap();
    }
    (to, from, requests)
}

/// 取出 runtime 实际收到的请求（method, params）。
fn sent(requests: &mut mpsc::Receiver<ClientMsg>) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    while let Ok(message) = requests.try_recv() {
        if let ClientMsg::Request { method, params, .. } = message {
            out.push((method.as_str().to_owned(), params));
        }
    }
    out
}

fn command_type(params: &Value) -> &str {
    params["type"].as_str().unwrap_or("?")
}

#[tokio::test]
async fn unknown_command_never_reaches_the_model_and_restores_the_draft() {
    // 未知命令是本地错误：不需要任何 runtime 回包。
    let (to, mut from, mut requests) = harness(Vec::new()).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("/compactfoo keep");
    view.sync_completion();

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert!(sent(&mut requests).is_empty(), "未知命令不能发给模型");
    assert_eq!(view.editor.text(), "/compactfoo keep");
    assert!(
        view.notices
            .last()
            .is_some_and(|notice| notice.contains("Unknown command")),
        "{:?}",
        view.notices
    );
}

#[tokio::test]
async fn busy_compact_is_rejected_without_bypassing_admission() {
    let (to, mut from, mut requests) = harness(Vec::new()).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.pending_submit = true;
    view.editor.insert("/compact keep this");
    view.sync_completion();

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert!(sent(&mut requests).is_empty(), "busy 时不能绕过 admission");
    assert_eq!(view.editor.text(), "/compact keep this");
    assert!(view.pending_submit);
    assert!(view.notices.last().is_some_and(|n| n.contains("busy")));
}

#[tokio::test]
async fn pending_interaction_treats_compact_as_an_answer() {
    let (to, mut from, mut requests) = harness(vec![json!({"status":"accepted"})]).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.state = json!({
        "pendingInteractions":[{
            "interactionId":"i1",
            "kind":"question",
            "payload":{"input":{"questions":[{"question":"plan?"}]}}
        }]
    });
    view.editor.insert("/compact now");
    view.sync_completion();

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let sent = sent(&mut requests);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "v4/command");
    assert_eq!(command_type(&sent[0].1), "resolveInteraction");
    assert_eq!(
        sent[0].1["payload"]["answer"]["content"]["answers"]["plan?"],
        "/compact now"
    );
    assert!(view.editor.text().is_empty());
}

#[tokio::test]
async fn busy_quit_still_stops_without_sending_a_prompt() {
    let (to, mut from, mut requests) = harness(vec![json!({"status":"accepted"})]).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.pending_submit = true;
    view.editor.insert("/quit");

    assert!(
        submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let sent = sent(&mut requests);
    assert_eq!(sent.len(), 1);
    assert_eq!(command_type(&sent[0].1), "stop");
}

#[tokio::test]
async fn plain_prompt_still_sends_text() {
    let (to, mut from, mut requests) = harness(vec![json!({"status":"accepted"})]).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("hello\nworld");
    view.sync_completion();

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let sent = sent(&mut requests);
    assert_eq!(sent.len(), 1);
    assert_eq!(command_type(&sent[0].1), "sendText");
    assert_eq!(sent[0].1["payload"]["text"], "hello\nworld");
    assert!(view.editor.text().is_empty());
}

#[tokio::test]
async fn rejected_submit_keeps_the_same_draft() {
    let (to, mut from, mut requests) =
        harness(vec![json!({"status":"rejected","message":"owner moved"})]).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("hello");
    view.sync_completion();

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let sent = sent(&mut requests);
    assert_eq!(sent.len(), 1);
    assert_eq!(command_type(&sent[0].1), "sendText");
    assert_eq!(view.editor.text(), "hello");
    assert!(
        view.notices
            .last()
            .is_some_and(|notice| notice.contains("owner moved"))
    );
    assert!(!view.pending_submit);
}

#[tokio::test]
async fn enter_accepts_the_alias_completion_before_dispatching_compact() {
    let (to, mut from, mut requests) = harness(vec![json!({"status":"accepted"})]).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    // 无参数、无空白的别名草稿会被补全归一化为 canonical `/compact`。
    view.editor.insert("/compress");
    view.sync_completion();

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let sent = sent(&mut requests);
    assert_eq!(sent.len(), 1);
    // 发 canonical sendText 而不是 type "compact"：后者的 payload schema 是 z.object({})，
    // 真实 parse_command 会把 text strip 掉；core 在 parse 后已有 sendText→compact 归一化。
    assert_eq!(command_type(&sent[0].1), "sendText");
    assert_eq!(sent[0].1["payload"]["text"], "/compact");
    let parsed = zcode_cli_protocol::parse_command(&sent[0].1)
        .expect("canonical sendText 必须通过真实协议解析");
    assert_eq!(parsed.kind, "sendText");
    assert_eq!(parsed.payload["text"], "/compact");
}

#[tokio::test]
async fn compact_instructions_keep_inner_whitespace_without_completion() {
    let (to, mut from, mut requests) = harness(vec![json!({"status":"accepted"})]).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("/compact keep  these\nlines");
    view.sync_completion();

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let sent = sent(&mut requests);
    assert_eq!(sent.len(), 1);
    assert_eq!(command_type(&sent[0].1), "sendText");
    assert_eq!(sent[0].1["payload"]["text"], "/compact keep  these\nlines");
    // 附加指令必须真的穿过 v4 schema（内部空白与换行不变），core 才会回填给 compact。
    let parsed = zcode_cli_protocol::parse_command(&sent[0].1)
        .expect("canonical sendText 必须通过真实协议解析");
    assert_eq!(
        parsed.payload["text"]
            .as_str()
            .unwrap_or("?")
            .strip_prefix("/compact "),
        Some("keep  these\nlines")
    );
    assert_eq!(view.editor.text(), "");
}

#[tokio::test]
async fn compact_ack_rejection_does_not_fake_success() {
    let (to, mut from, _requests) =
        harness(vec![json!({"status":"rejected","reasonCode":"busy"})]).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("/compact");
    view.sync_completion();

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert_eq!(view.editor.text(), "/compact");
    assert!(view.notices.last().is_some_and(|n| n.contains("busy")));
    assert_ne!(view.state["control"]["phase"], "completed");
}

// ------------------------------------------------------- slash 补全确认路径

#[tokio::test]
async fn tab_then_enter_on_root_slash_runs_local_help_without_a_model_turn() {
    // `/` 的默认候选是目录首项 help：Tab 只写回，Enter 才走本地命令分流。
    let (to, mut from, mut requests) = harness(Vec::new()).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("/");
    view.sync_completion();
    assert_eq!(view.completion.replacement().as_deref(), Some("/help"));

    view.accept_completion();
    assert_eq!(view.editor.text(), "/help");
    assert!(sent(&mut requests).is_empty(), "Tab 不提交");

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert!(sent(&mut requests).is_empty(), "/help 是本地命令");
    assert!(
        view.notices
            .last()
            .is_some_and(|notice| notice.contains("/compact")),
        "{:?}",
        view.notices
    );
    assert_eq!(view.editor.text(), "");
}

#[tokio::test]
async fn substring_candidate_odel_completes_to_the_model_picker() {
    // `/odel` 只是 model 的子串命中；可见就能确认，不得点了没反应。
    let (to, mut from, mut requests) = harness(Vec::new()).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.models = vec![json!({"ref":{"providerId":"p","modelId":"m"}})];
    view.editor.insert("/odel");
    view.sync_completion();
    assert_eq!(view.completion.replacement().as_deref(), Some("/model"));

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let selector = view.selector.as_ref().expect("/model 打开选择器");
    assert_eq!(selector.draft, "/model");
    assert!(sent(&mut requests).is_empty(), "补全本身不发模型请求");
}

#[tokio::test]
async fn arrow_selection_under_mo_confirms_model_not_mode() {
    let (to, mut from, mut requests) = harness(Vec::new()).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.models = vec![json!({"ref":{"providerId":"p","modelId":"m"}})];
    view.editor.insert("/mo");
    view.sync_completion();
    // 目录顺序默认 mode，下箭头一次选中 model。
    view.completion.move_by(1);
    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    let selector = view.selector.as_ref().expect("model 选择器");
    assert_eq!(selector.draft, "/model");
    assert!(sent(&mut requests).is_empty());
}

#[tokio::test]
async fn compactfoo_has_no_candidates_and_never_completes_into_compact() {
    let (to, mut from, mut requests) = harness(Vec::new()).await;
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.editor.insert("/compactfoo");
    view.sync_completion();
    assert!(!view.completion.visible(), "未知命令没有候选");
    assert_eq!(view.completion.replacement(), None);

    assert!(
        !submit_editor(&mut client, &mut view, &request())
            .await
            .unwrap()
    );
    assert!(sent(&mut requests).is_empty(), "拼错命令不发给模型");
    assert_eq!(view.editor.text(), "/compactfoo");
    assert!(view.notices.last().is_some_and(|n| n.contains("Unknown")));
}
