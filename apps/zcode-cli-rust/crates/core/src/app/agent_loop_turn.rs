//! `run` 的请求准备阶段：技能/子代理目录、工具定义过滤与手动压缩。
//! 拆分自 `agent_loop.rs`，语句逐字搬移（只把局部量收进 `Prepared`），
//! 只为把源文件保持在 400 行上限内。
use crate::contract::{ContextPort, EventSink, ModelPort, ToolPort};
use anyhow::Result;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// `run` 在进入轮次循环前固定的请求事实。
pub(super) struct Prepared {
    pub skills: crate::domain::skills::SkillCatalog,
    pub profile: Option<crate::domain::subagent::Profile>,
    pub definitions: Vec<Value>,
    pub profiles: Vec<crate::domain::subagent::Profile>,
    pub tool_filter: crate::domain::session_runtime::ToolFilter,
    /// 手动压缩已经接管本轮（`run` 直接结束）。
    pub manual_done: bool,
}

pub(super) async fn prepare(
    model: &dyn ModelPort,
    tools: &dyn ToolPort,
    context: &dyn ContextPort,
    history: &mut super::super::context::RunContext,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> Result<Prepared> {
    let manual = history.manual.take();
    super::super::skills::initialize(tools, context, history, sink, cancel).await?;
    let skills = history.skills.clone().unwrap_or_default();
    let profile = history.agent_profile.clone();
    let mut definitions = tools.scoped_definitions(&sink.session_id, cancel).await?;
    // 3.18 F14：CronPauseSelf 只在本轮有 Host 准入的 automationId 时注册
    // （Node turn-tool-visibility 的非执行轮隐藏）；普通轮不提供该入口。
    if history.automation_id.is_none() {
        definitions.retain(|d| d["function"]["name"] != crate::domain::automation::PAUSE_SELF);
    }
    // 3.18 App 会话控制：只有本轮授予（Host 能力 + mainRoot + 非子代理）才注册十二工具。
    // 无 Host / 旧 Host / 子代理 / 非根会话都不注册；强行调用在执行边界得到明确不可用错误。
    if !history.app_control {
        definitions.retain(|d| {
            !crate::domain::app_control::is_tool(d["function"]["name"].as_str().unwrap_or(""))
        });
    }
    if let Some(profile) = &profile {
        // 子代理不注册 plan 工具（Node subagent tool-policy）。
        definitions.retain(|d| {
            let name = d["function"]["name"].as_str().unwrap_or("");
            profile.allows(name) && !matches!(name, "EnterPlanMode" | "ExitPlanMode")
        });
    }
    if !skills.enabled {
        definitions.retain(|d| d["function"]["name"] != "Skill");
    }
    tools.model_definitions(&mut definitions, &model.format_properties()["inputFormat"]);
    // Node getTools(model)：只有声明 supportsNativeWebSearch 的模型提供 WebSearch。
    if !model.supports_native_web_search() {
        definitions.retain(|d| d["function"]["name"] != "WebSearch");
    }
    let tool_filter = history.tool_filter.clone();
    definitions.retain(|d| tool_filter.allows(d["function"]["name"].as_str().unwrap_or("")));
    // 与 Node 一致：禁用集合只从提供给模型的定义中移除；执行边界不据此拦截（D1）。
    super::super::tool_search::hide(&mut definitions, &history.tool_disallowlist);
    let profiles = if definitions.iter().any(|d| d["function"]["name"] == "Agent") {
        tools
            .agent_profiles(cancel, &history.additional_directories)
            .await?
    } else {
        vec![]
    };
    super::super::subagent_tools::describe_catalog(&mut definitions, &profiles);
    super::super::plugin_reference::inject(tools, history, (&skills, &definitions), sink, cancel)
        .await?;
    let mut manual_done = false;
    if let Some(instructions) = manual {
        super::super::manual_compact::run(
            model,
            tools,
            context,
            history,
            (&skills, profile.as_ref()),
            &definitions,
            &instructions,
            sink,
            cancel,
        )
        .await?;
        manual_done = true;
    }

    Ok(Prepared {
        skills,
        profile,
        definitions,
        profiles,
        tool_filter,
        manual_done,
    })
}
