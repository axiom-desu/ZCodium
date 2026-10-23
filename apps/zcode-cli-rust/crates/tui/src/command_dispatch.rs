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
    // `/queue` 前缀由 queue 模块精确拥有：命中后不再进入通用白名单，也不改其他分支。
    if crate::queue::handles(text) {
        crate::queue::dispatch(client, view, text).await?;
        return Ok(false);
    }
    // compact 的附注是正文，必须先按完整首 token 精确识别，再进入普通白名单分流。
    if let Some(instructions) = commands::compact_instructions(text) {
        compact(client, view, instructions).await?;
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
        ["/sessions"] => {
            let data = client
                .call(
                    view,
                    Method::SessionList,
                    json!({"workspace":request.workspace}),
                )
                .await?;
            for session in data["sessions"].as_array().into_iter().flatten() {
                view.push(&format!(
                    "{} {}",
                    session["sessionId"].as_str().unwrap_or("?"),
                    session["title"].as_str().unwrap_or("")
                ));
            }
        }
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

/// 压缩只走 actor admission：不附带启动附件、不写本地 marker。
///
/// 不能直接发 `type: "compact"` + `payload.text`：共享 v4 schema 的 compact payload 是
/// `z.object({})`，真实 `protocol::parse_command` 按 zod strip 语义会丢掉附加指令
/// （PTY 实测指令因此丢失；fake ACK 只比对发出的对象，所以漏检）。因此这里发送
/// canonical `/compact [instructions]` 的最小 sendText，由 `crates/core/src/app/commands.rs`
/// 既有的 parse 后归一化把 `text` 首 token 恰为 `/compact` 的输入改判为 compact 并回填指令，
/// 控制轮不会变成普通用户消息（不调用 `session::submit`、不插 user row、不加 pending/queue）。
async fn compact(client: &mut Client<'_>, view: &mut View, instructions: &str) -> Result<()> {
    // core 归一化按 `trimmed == "/compact" || trimmed.starts_with("/compact ")` 识别，
    // 所以无指令时不能带尾随空格；有指令时保留其内部换行与空格。
    let text = if instructions.is_empty() {
        "/compact".to_owned()
    } else {
        format!("/compact {instructions}")
    };
    let ack = client
        .call(
            view,
            Method::Command,
            session::command(&view.session, "sendText", json!({"text": text})),
        )
        .await?;
    session::accepted(ack)
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
