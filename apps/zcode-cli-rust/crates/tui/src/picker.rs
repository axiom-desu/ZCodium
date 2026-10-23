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
                Choice::Queue(_) => false,
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
    // 队列菜单在 busy 时仍然可用（排队输入正是运行中输入的唯一入口）：
    // typed choice 先分流给 queue，再进入其余选择器的 busy 门禁。
    if matches!(
        view.selector
            .as_ref()
            .and_then(|selector| selector.choice().map(|(choice, _)| choice)),
        Some(Choice::Queue(_))
    ) {
        crate::queue::confirm(client, view).await?;
        return Ok(());
    }
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
        // 队列菜单由 queue 模块独占（typed id + 捕获的 CAS 基线，含关闭时机）。
        Choice::Queue(_) => {
            crate::queue::confirm(client, view).await?;
            return Ok(());
        }
    }
    // 只有 actor 接受并刷新成功后才关闭选择器；配置事实仍由 snapshot 给出。
    view.selector = None;
    Ok(())
}
#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;
