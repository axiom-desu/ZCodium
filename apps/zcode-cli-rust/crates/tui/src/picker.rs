//! 模型/档位/会话选择器：本地候选直接打开，会话列表走只读 workflow。
//!
//! 确认动作只登记一条 mutation workflow（setting 或 boot），不等 ACK；菜单是否关闭由
//! 该 workflow 在成功后按发起时的 owner/世代结算，迟到的旧回包不会清掉新菜单。
use crate::{
    client::Client,
    flow::Flow,
    flow_picker::PickerOpen,
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

/// 会话候选：稳定 id + 标题，按 updatedAt 倒序取前 200（与旧菜单一致）。
pub(crate) fn session_options(view: &View, data: &Value) -> Vec<(Choice, String)> {
    let mut sessions = data["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s.get("parentSessionId").is_none_or(Value::is_null))
        .collect::<Vec<_>>();
    sessions.sort_by_key(|s| std::cmp::Reverse(s["updatedAt"].as_u64().unwrap_or(0)));
    let _ = view;
    sessions
        .into_iter()
        .take(200)
        .filter_map(|s| {
            let id = s["sessionId"].as_str()?;
            Some((
                Choice::Session(id.to_owned()),
                format!("{} · {id}", s["title"].as_str().unwrap_or("")),
            ))
        })
        .collect()
}

/// 菜单打开时把光标放到当前生效项；过滤为空时列表与原始 options 同序。
pub(crate) fn select_current(view: &View, selector: &mut Selector) {
    selector.selected = selector
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

fn show(view: &mut View, title: &str, options: Vec<(Choice, String)>, draft: &str) {
    let selector = Selector::new(
        title.to_owned(),
        options,
        view.session.clone(),
        draft.to_owned(),
    );
    let Some(mut selector) = selector else {
        let note = view.text("No choices available", "暂无可选项").to_owned();
        view.push(&note);
        return;
    };
    select_current(view, &mut selector);
    view.selector = Some(selector);
}

/// 打开选择器：`/model`、`/mode` 的候选全部来自本地快照，不需要请求。
pub(crate) fn begin_open(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<()> {
    match text.trim() {
        "/model" => show(
            view,
            view.text("Models", "模型"),
            model_options(&view.models),
            text,
        ),
        "/mode" => show(
            view,
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
            text,
        ),
        _ => {
            if !client.begin_flow(
                view,
                Flow::Picker(PickerOpen::new(view, &request.workspace, text)),
            )? {
                anyhow::bail!(
                    "{}",
                    view.text(
                        "A session list request is already in flight.",
                        "已有会话列表请求在等待回包。"
                    )
                );
            }
        }
    }
    Ok(())
}

pub(crate) async fn open(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<()> {
    begin_open(client, view, request, text)?;
    #[cfg(test)]
    crate::frontend_test_support::drive(client, view).await;
    Ok(())
}

/// 确认的唯一生产入口：只登记 workflow（或本地开子菜单），不等回包。
pub(crate) fn begin_confirm(
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
        crate::queue::begin_confirm(client, view)?;
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
        Choice::Model(model) => session::begin_setting(
            client,
            view,
            Method::SessionSetModel,
            json!({"sessionId":view.session,"model":model}),
        )?,
        Choice::Mode(mode) => session::begin_setting(
            client,
            view,
            Method::SessionSetMode,
            json!({"sessionId":view.session,"mode":mode}),
        )?,
        Choice::Session(id) => {
            session::begin_open(client, view, request, Resume::Id(id))?;
        }
        // 队列菜单由 queue 模块独占（typed id + 捕获的 CAS 基线，含关闭时机）。
        Choice::Queue(_) => crate::queue::begin_confirm(client, view)?,
    }
    Ok(())
}

pub(crate) async fn confirm(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
) -> Result<()> {
    begin_confirm(client, view, request)?;
    #[cfg(test)]
    crate::frontend_test_support::drive(client, view).await;
    Ok(())
}
#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;
