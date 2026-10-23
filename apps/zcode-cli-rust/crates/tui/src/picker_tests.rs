use super::*;
use crate::{
    client::Client,
    projection_tests::{request, view},
};
use serde_json::json;
use tokio::sync::mpsc;
use zcode_cli_core_api::{ClientMsg, Method, RuntimeError, ServerMsg};

fn model_selector(owner: &str, filter: &str) -> Selector {
    let mut selector = Selector::new(
        "Models".into(),
        vec![(
            Choice::Model(json!({"providerId":"openai","modelId":"gpt-5"})),
            "openai / gpt-5".into(),
        )],
        owner.into(),
        "/model".into(),
    )
    .unwrap();
    if !filter.is_empty() {
        selector.push_filter(filter);
    }
    selector
}

#[tokio::test]
async fn rejected_setter_keeps_selector_and_draft() {
    let (to, mut input) = mpsc::channel(4);
    let (output, mut from) = mpsc::channel(4);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request { token, method, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(method, Method::SessionSetModel);
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Err(RuntimeError::InvalidParams("unknown model".into())),
            }])
            .await
            .unwrap();
    });
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.selector = Some(model_selector("s", ""));
    // 非阻塞：确认只登记 workflow；拒绝效果由同一 poll 结算成明确错误。
    confirm(&mut client, &mut view, &request()).await.unwrap();
    assert!(
        view.notices
            .last()
            .is_some_and(|note| note.contains("unknown model")),
        "{:?}",
        view.notices.last()
    );
    // 失败时不得丢弃 selector（否则 Esc 无法恢复原草稿）。
    assert_eq!(view.selector.as_ref().unwrap().draft, "/model");
    actor.await.unwrap();
}

#[tokio::test]
async fn empty_filter_result_does_not_submit_or_drop_the_selector() {
    let (to, mut input) = mpsc::channel(4);
    let (_output, mut from) = mpsc::channel(4);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.selector = Some(model_selector("s", "no-match"));
    confirm(&mut client, &mut view, &request()).await.unwrap();
    assert!(input.try_recv().is_err());
    assert_eq!(view.selector.as_ref().unwrap().draft, "/model");
}

#[tokio::test]
async fn stale_owner_keeps_selector_and_never_submits() {
    let (to, mut input) = mpsc::channel(4);
    let (_output, mut from) = mpsc::channel(4);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.selector = Some(model_selector("old-session", ""));
    let error = confirm(&mut client, &mut view, &request())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("old session"));
    assert_eq!(view.selector.as_ref().unwrap().draft, "/model");
    assert!(input.try_recv().is_err());
}

#[tokio::test]
async fn accepted_setter_clears_selector_and_shows_the_actor_snapshot() {
    let (to, mut input) = mpsc::channel(4);
    let (output, mut from) = mpsc::channel(4);
    let actor = tokio::spawn(async move {
        let ClientMsg::Request { token, method, .. } = input.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(method, Method::SessionSetModel);
        output
            .send(vec![ServerMsg::Reply {
                token,
                result: Ok(json!({"ok":true})),
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
                result: Ok(json!({"snapshot":{"sessionId":"s","seq":1,"rows":{"window":[]},"control":{"canStop":false},"config":{"mode":"build","provider":"openai","model":"gpt-5"},"pendingInteractions":[]}})),
            }])
            .await
            .unwrap();
    });
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.selector = Some(model_selector("s", ""));
    confirm(&mut client, &mut view, &request()).await.unwrap();
    assert!(view.selector.is_none());
    // 新模型来自 actor 快照，不由 TUI 本地改 config。
    assert_eq!(view.state["config"]["model"], "gpt-5");
    actor.await.unwrap();
}

#[tokio::test]
async fn empty_filter_defaults_to_the_current_mode() {
    let (to, _input) = mpsc::channel(1);
    let (_output, mut from) = mpsc::channel(1);
    let mut client = Client::new(&to, &mut from);
    let mut view = view();
    view.state["config"]["mode"] = "edit".into();
    open(&mut client, &mut view, &request(), "/mode")
        .await
        .unwrap();
    let selector = view.selector.as_ref().unwrap();
    assert!(selector.filter.is_empty());
    assert_eq!(selector.choice().unwrap().0, Choice::Mode("edit".into()));
}

#[test]
fn model_refs_keep_colons_and_do_not_invent_reasoning() {
    let options = model_options(&[
        json!({"ref":{"providerId":"personal:fixture","modelId":"v:model"}}),
        json!({"ref":{"providerId":"p","modelId":"m"},"reasoning":{"defaultLevel":"none"}}),
    ]);
    assert_eq!(
        options[0].0,
        Choice::Model(json!({"providerId":"personal:fixture","modelId":"v:model"}))
    );
    assert_eq!(
        options[1].0,
        Choice::Model(json!({"providerId":"p","modelId":"m","options":{"reasoningLevel":"none"}}))
    );
}
