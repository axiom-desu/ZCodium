//! 已实现 slash 命令的执行。
//!
//! 这里只做“前端命令 → 原有端口”的映射：会话、权限、admission、模型与推理设置
//! 的事实仍由 core actor 独占，本模块不新增业务写入路径，也不在本地伪造成功。
use crate::{
    client::Client,
    commands,
    projection::View,
    session, telemetry,
    transport::{Request, Resume},
};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

/// 本地诊断：错误沿既有 draft-preserving 路径回到用户，绝不发给模型。
fn local_error(zh: bool, en: String, zh_text: String) -> anyhow::Error {
    anyhow!("{}", if zh { zh_text } else { en })
}

fn usage_error(view: &View, usage: &str) -> anyhow::Error {
    local_error(
        view.zh,
        format!("Invalid arguments. Usage: {usage}"),
        format!("参数不正确。用法：{usage}"),
    )
}

/// `session::slash` 的实现：返回值表示“是否退出”。
pub(crate) async fn dispatch(
    client: &mut Client<'_>,
    view: &mut View,
    request: &Request,
    text: &str,
) -> Result<bool> {
    // `/draft` 是纯本地恢复入口：不发送、不拼接、不跨会话重发；这条命令必须在
    // has_rejected 拦截新提交时仍然可用，且不依赖终端能否区分组合键。
    if text.split_whitespace().next() == Some("/draft") {
        let words: Vec<_> = text.split_whitespace().collect();
        match words.as_slice() {
            ["/draft"] => {
                let status = crate::frontend_operations::draft_status(view);
                view.push(&status);
                return Ok(false);
            }
            ["/draft", "swap" | "restore"] => {
                crate::frontend_operations::swap_alternate(view, false);
                return Ok(false);
            }
            ["/draft", "discard"] => {
                crate::frontend_operations::swap_alternate(view, true);
                return Ok(false);
            }
            ["/draft", ..] => {
                return Err(usage_error(view, "/draft [swap|discard]"));
            }
            _ => {}
        }
    }
    // `/queue` 前缀由 queue 模块精确拥有：命中后不再进入通用白名单，也不改其他分支。
    if crate::queue::handles(text) {
        crate::queue::dispatch(client, view, text).await?;
        return Ok(false);
    }
    // compact 的附注是正文，必须先按完整首 token 精确识别，再进入普通白名单分流。
    if let Some(instructions) = commands::compact_instructions(text) {
        session::compact(client, view, text, instructions).await?;
        return Ok(false);
    }
    let words: Vec<_> = text.split_whitespace().collect();
    match words.as_slice() {
        ["/quit" | "/exit"] => return Ok(true),
        ["/help"] => {
            let listing = commands::help(None, view.zh)?;
            view.push(&listing);
        }
        ["/help", topic] => {
            let listing = commands::help(Some(topic), view.zh)?;
            view.push(&listing);
        }
        ["/help", ..] => return Err(usage_error(view, "/help [command]")),
        ["/new"] => session::open(client, view, request, Resume::New).await?,
        ["/new", ..] => return Err(usage_error(view, "/new")),
        ["/resume", id] => session::open(client, view, request, Resume::Id((*id).into())).await?,
        ["/resume"] | ["/resume", _, _, ..] => {
            return Err(usage_error(view, "/resume <sessionId>"));
        }
        ["/sessions"] => session::begin_list(client, view, request)?,
        ["/sessions", ..] => return Err(usage_error(view, "/sessions")),
        ["/mode", mode] => {
            session::set_setting(
                client,
                view,
                Method::SessionSetMode,
                json!({"sessionId":view.session,"mode":mode}),
            )
            .await?;
        }
        ["/mode"] | ["/mode", _, _, ..] => {
            return Err(usage_error(view, "/mode <build|plan|edit|yolo>"));
        }
        ["/model"] => {
            for model in view.models.clone() {
                view.push(&format!(
                    "{} {}",
                    model["ref"]["providerId"].as_str().unwrap_or(""),
                    model["ref"]["modelId"].as_str().unwrap_or("")
                ));
            }
            let hint = view
                .text(
                    "Use /model <providerId> <modelId> [reasoningLevel]",
                    "使用 /model <providerId> <modelId> [reasoningLevel]",
                )
                .to_owned();
            view.push(&hint);
        }
        ["/model", provider, model] | ["/model", provider, model, _] => {
            let mut selection = json!({"providerId":provider,"modelId":model});
            let level = words.get(3).copied().or_else(|| {
                view.models
                    .iter()
                    .find(|m| m["ref"]["providerId"] == *provider && m["ref"]["modelId"] == *model)
                    .and_then(|m| m["reasoning"]["defaultLevel"].as_str())
            });
            if let Some(level) = level {
                selection["options"] = json!({"reasoningLevel":level});
            }
            session::set_setting(
                client,
                view,
                Method::SessionSetModel,
                json!({"sessionId":view.session,"model":selection}),
            )
            .await?;
        }
        ["/model", ..] => {
            return Err(usage_error(
                view,
                "/model [providerId modelId [reasoningLevel]]",
            ));
        }
        ["/effort" | "/variant"] | ["/effort" | "/variant", "list"] => {
            let listing = effort_listing(view)?;
            view.push(&listing);
        }
        ["/effort" | "/variant", level] => effort_set(client, view, level).await?,
        ["/effort" | "/variant", _, _, ..] => {
            return Err(usage_error(view, "/effort [list|<level>]"));
        }
        // 只读遥测：统一走 Client 的读票据，不另起请求通道，也不阻塞 stop/quit。
        ["/mcp"] => telemetry::request_mcp(client, view, request),
        ["/mcp", ..] => return Err(usage_error(view, "/mcp")),
        ["/usage"] => telemetry::request_usage(client, view)?,
        ["/usage", ..] => return Err(usage_error(view, "/usage")),
        _ => {
            let token = words.first().copied().unwrap_or("?");
            return Err(local_error(
                view.zh,
                format!("Unknown command: {token}. Use /help to list implemented commands."),
                format!("未知命令：{token}。使用 /help 查看已实现命令。"),
            ));
        }
    }
    Ok(false)
}

/// actor 当前提交的档位与可用档位；空档位是明确错误，不编造默认等级。
///
/// `thoughtLevels` 里的空字符串/纯空白不是有效档位（actor 未提供档位时会给出
/// `[""]`），若不过滤，`/effort` 会广告一个空档位，`/effort <空>` 还会把
/// 空值发给 setter。这里只过滤空项，档位值本身仍由 actor 最终校验。
fn effort_levels(view: &View) -> Vec<String> {
    view.state["config"]["thoughtLevels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|level| !level.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

fn effort_listing(view: &View) -> Result<String> {
    let levels = effort_levels(view);
    if levels.is_empty() {
        bail!(
            "{}",
            view.text(
                "The current model offers no reasoning levels.",
                "当前模型没有可用推理档位。"
            )
        );
    }
    let current = view.state["config"]["thought"]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or("—");
    Ok(if view.zh {
        format!("档位：{current} · 可用：{}", levels.join(", "))
    } else {
        format!("effort: {current} · levels: {}", levels.join(", "))
    })
}

async fn effort_set(client: &mut Client<'_>, view: &mut View, requested: &str) -> Result<()> {
    let levels = effort_levels(view);
    if levels.is_empty() {
        bail!(
            "{}",
            view.text(
                "The current model offers no reasoning levels.",
                "当前模型没有可用推理档位。"
            )
        );
    }
    // 大小写不敏感精确匹配后回写 canonical 值，档位事实仍由 actor 最终验证。
    let Some(canonical) = levels
        .iter()
        .find(|level| level.eq_ignore_ascii_case(requested))
    else {
        bail!(
            "{}",
            if view.zh {
                format!("不支持的推理档位：{requested}。可用：{}", levels.join(", "))
            } else {
                format!(
                    "Unsupported reasoning effort: {requested}. Available: {}",
                    levels.join(", ")
                )
            }
        );
    };
    let params = json!({"sessionId":view.session,"thoughtLevel":canonical});
    session::set_setting(client, view, Method::SessionSetThoughtLevel, params).await
}
