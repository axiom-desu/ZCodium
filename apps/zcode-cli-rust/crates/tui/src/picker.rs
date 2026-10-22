use crate::{
    client::Client,
    projection::View,
    selector::{Choice, Selector},
    session,
    transport::{Request, Resume},
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

pub(crate) fn model_options(models: &[Value]) -> Vec<(Choice, String)> {
    models
        .iter()
        .take(200)
        .filter_map(|m| {
            let provider = m["ref"]["providerId"].as_str()?;
            let model = m["ref"]["modelId"].as_str()?;
            let mut selection = json!({"providerId":provider,"modelId":model});
            if let Some(level) = m["reasoning"]["defaultLevel"].as_str() {
                selection["options"] = json!({"reasoningLevel":level});
            }
            Some((Choice::Model(selection), format!("{provider} / {model}")))
        })
        .collect()
}
pub(crate) async fn open(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<()> {
    let owner = view.session.clone();
    let (title, options) = match text.trim() {
        "/model" => (view.text("Models", "模型"), model_options(&view.models)),
        "/mode" => (
            view.text("Modes", "模式"),
            ["build", "plan", "edit", "yolo"]
                .into_iter()
                .map(|m| {
                    let label = if m == "yolo" {
                        view.text("yolo · bypass approvals", "yolo · 跳过权限确认")
                    } else {
                        m
                    };
                    (Choice::Mode(m.into()), label.to_owned())
                })
                .collect(),
        ),
        _ => {
            let data = client
                .call(
                    view,
                    Method::SessionList,
                    json!({"workspace":request.workspace}),
                )
                .await?;
            let mut sessions = data["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|s| s.get("parentSessionId").is_none_or(Value::is_null))
                .collect::<Vec<_>>();
            sessions.sort_by_key(|s| std::cmp::Reverse(s["updatedAt"].as_u64().unwrap_or(0)));
            let options = sessions
                .into_iter()
                .take(200)
                .filter_map(|s| {
                    let id = s["sessionId"].as_str()?;
                    Some((
                        Choice::Session(id.to_owned()),
                        format!("{} · {id}", s["title"].as_str().unwrap_or("")),
                    ))
                })
                .collect();
            (view.text("Sessions", "会话"), options)
        }
    };
    ensure!(
        owner == view.session,
        "Session changed while loading choices"
    );
    let mut selector = Selector::new(title.to_owned(), options, owner, text.to_owned());
    if let Some(s) = selector.as_mut() {
        // 打开时 filter 为空，过滤列表与原始 options 同序，因此当前项下标可直接复用。
        s.selected = s
            .options
            .iter()
            .position(|(choice, _)| match choice {
                Choice::Model(model) => {
                    model["providerId"] == view.state["config"]["provider"]
                        && model["modelId"] == view.state["config"]["model"]
                }
                Choice::Mode(mode) => mode == view.mode(),
                Choice::Session(id) => id == &view.session,
            })
            .unwrap_or(0);
    }
    view.selector = selector;
    if view.selector.is_none() {
        view.push(view.text("No choices available", "暂无可选项"));
    }
    Ok(())
}
pub(crate) async fn confirm(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
) -> Result<()> {
    ensure!(!view.busy(), "Turn is busy; selection was not applied");
    // 先只读检查并克隆 typed choice：失败/stale owner/无结果时 selector 必须原样保留，
    // 这样 Esc 仍能恢复原草稿，也不会按过滤后的行号猜原始选项。
    let Some(selector) = view.selector.as_ref() else {
        return Ok(());
    };
    ensure!(
        selector.owner == view.session,
        "Selection belongs to an old session"
    );
    let Some((choice, _)) = selector.choice() else {
        return Ok(());
    };
    let choice = choice.clone();
    match choice {
        Choice::Model(model) => {
            session::set_setting(
                client,
                view,
                Method::SessionSetModel,
                json!({"sessionId":view.session,"model":model}),
            )
            .await?;
        }
        Choice::Mode(mode) => {
            session::set_setting(
                client,
                view,
                Method::SessionSetMode,
                json!({"sessionId":view.session,"mode":mode}),
            )
            .await?;
        }
        Choice::Session(id) => {
            session::open(client, view, request, Resume::Id(id)).await?;
        }
    }
    // 只有 actor 接受并刷新成功后才关闭选择器；配置事实仍由 snapshot 给出。
    view.selector = None;
    Ok(())
}
#[cfg(test)]
mod tests {
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
        let error = confirm(&mut client, &mut view, &request())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unknown model"));
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
            Choice::Model(
                json!({"providerId":"p","modelId":"m","options":{"reasoningLevel":"none"}})
            )
        );
    }
}
