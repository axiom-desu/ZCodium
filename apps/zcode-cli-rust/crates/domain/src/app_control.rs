//! App 模式（Host 会话）十二个会话控制意图的领域事实。
//!
//! 事实源是本仓 TS 契约：`packages/session-control/src/app-tool-contracts.ts`（工具名、
//! 文案、JSON Schema）与 `app-control-protocol.ts`（`appControl/<action>` 线上方法名）。
//! Rust 只持有封闭意图表、工具面身份注入规则与回执形状；身份（callerSessionId/callId）
//! 由运行上下文构造，模型输入只承载 `input`。
use serde_json::{Map, Value};

/// 工具名前缀与线上方法名共用同一个封闭集合：`appControl/<action>`。
pub const METHOD_PREFIX: &str = "appControl/";

/// 十二意图的工具名（TS `appSessionControlToolContracts` 的顺序）。
pub const TOOL_NAMES: [&str; 12] = [
    "ListProjects",
    "ListSessions",
    "ReadSession",
    "CreateSession",
    "ForkSession",
    "SendToSession",
    "WaitSessions",
    "InterruptSession",
    "RenameSession",
    "OpenSession",
    "SetSessionArchived",
    "SetSessionPinned",
];

/// 一个意图：工具名、Host 方法名、工具面是否有 `retryOf`（写意图才有请求身份）。
pub struct Intent {
    pub tool: &'static str,
    pub action: &'static str,
    /// 线上方法名（`appControl/<action>`）；`ServerMsg::HostRequest` 需要 `&'static str`。
    pub method: &'static str,
    pub request_id: bool,
}

pub const INTENTS: [Intent; 12] = [
    entry(
        "ListProjects",
        "listProjects",
        "appControl/listProjects",
        false,
    ),
    entry(
        "ListSessions",
        "listSessions",
        "appControl/listSessions",
        false,
    ),
    entry(
        "ReadSession",
        "readSession",
        "appControl/readSession",
        false,
    ),
    entry(
        "CreateSession",
        "createSession",
        "appControl/createSession",
        true,
    ),
    entry("ForkSession", "forkSession", "appControl/forkSession", true),
    entry(
        "SendToSession",
        "sendToSession",
        "appControl/sendToSession",
        true,
    ),
    entry(
        "WaitSessions",
        "waitSessions",
        "appControl/waitSessions",
        false,
    ),
    entry(
        "InterruptSession",
        "interruptSession",
        "appControl/interruptSession",
        true,
    ),
    entry(
        "RenameSession",
        "renameSession",
        "appControl/renameSession",
        true,
    ),
    entry(
        "OpenSession",
        "openSession",
        "appControl/openSession",
        false,
    ),
    entry(
        "SetSessionArchived",
        "setSessionArchived",
        "appControl/setSessionArchived",
        true,
    ),
    entry(
        "SetSessionPinned",
        "setSessionPinned",
        "appControl/setSessionPinned",
        true,
    ),
];

/// 方法名是静态字面量（`HostRequest.method` 需要 `&'static str`）；
/// 与 `action` 的一致性由 `app_control_tests` 覆盖。
const fn entry(
    tool: &'static str,
    action: &'static str,
    method: &'static str,
    request_id: bool,
) -> Intent {
    Intent {
        tool,
        action,
        method,
        request_id,
    }
}

/// 工具名 → 意图。不在表里的名字不是 App 会话工具（CLI 八工具不在此列）。
pub fn intent(tool: &str) -> Option<&'static Intent> {
    INTENTS.iter().find(|intent| intent.tool == tool)
}

pub fn is_tool(tool: &str) -> bool {
    intent(tool).is_some()
}

/// Host 方法名（`appControl/<action>`）。
pub fn method(intent: &Intent) -> String {
    format!("{METHOD_PREFIX}{}", intent.action)
}

/// 根会话种类：TS `resolveAppControlEnabledBinding` 的等价事实。
pub fn is_root_task_type(task_type: &str) -> bool {
    matches!(task_type, "interactive" | "fork" | "workflow_parent")
}

/// `mainRoot`（TS 逐字等价）：fork 是独立任务；其余种类必须没有父会话。
pub fn is_main_root(task_type: &str, has_parent: bool) -> bool {
    task_type == "fork" || (!has_parent && matches!(task_type, "interactive" | "workflow_parent"))
}

/// 能力授予：Host 偏好回包 + mainRoot + 非子代理；模型输入不参与。
pub fn granted(host_enabled: bool, task_type: &str, has_parent: bool, subagent_run: bool) -> bool {
    host_enabled && !subagent_run && is_main_root(task_type, has_parent)
}

/// 未授予（无 Host / 旧 Host / 子代理 / 非根会话）时的执行边界结论；
/// 与 TS `SessionControlError("forbidden", …)` 同一文案。
pub const ERROR_UNAVAILABLE: &str = "Session control is unavailable in this execution context.";
pub const ERROR_INPUT_OBJECT: &str = "App session control input must be an object";
pub const ERROR_RETRY_UNSUPPORTED: &str =
    "This tool does not accept retryOf: it has no request identity to replay.";
pub const ERROR_CANCELLED: &str = "App session control was cancelled; target work is not stopped.";
/// `{ok:false}` 之外的任何形状（含空回执：旧 Host 的 `-32601`、参数拒绝的 `-32602`）。
///
/// 缺失回执只说明「Host 拒绝或不支持」，不能据此断言意图未生效：Host 可能已经执行、
/// 只是没能回答。文案因此保留 unknown 语义，绝不写成 applied 或 not applied。
pub const ERROR_REJECTED: &str =
    "appControl request was rejected or unavailable on the Host; the outcome is unknown.";

/// 工具面输入 → Host `input`：剥离 `retryOf` 并注入可信 `requestId`。
///
/// 身份来自执行上下文（`call_id`）或回执里回放的 `retryOf`，模型不能凭空注入别的 id。
pub fn prepare_input(intent: &Intent, args: &Value, call_id: &str) -> Result<Value, String> {
    let Some(object) = args.as_object() else {
        return Err(ERROR_INPUT_OBJECT.into());
    };
    let retry = object.get("retryOf");
    let replay = match retry {
        None => None,
        Some(Value::String(id)) if !id.trim().is_empty() && intent.request_id => {
            Some(id.trim().to_owned())
        }
        // 只读意图没有请求身份：多传 retryOf 是参数错误，不静默丢弃。
        Some(_) if !intent.request_id => return Err(ERROR_RETRY_UNSUPPORTED.into()),
        Some(_) => return Err("retryOf must be a non-empty requestId string".into()),
    };
    let mut input = Map::new();
    for (key, value) in object {
        if key != "retryOf" {
            input.insert(key.clone(), value.clone());
        }
    }
    if intent.request_id {
        let request_id = replay.unwrap_or_else(|| call_id.to_owned());
        input.insert("requestId".into(), Value::String(request_id));
    }
    Ok(Value::Object(input))
}

/// Host 回执 → 工具结果：只接受封闭信封，`result` 原样保留（含 Host 自己的 `unknown`）。
pub fn parse_reply(intent: &Intent, reply: &Value) -> Result<Value, String> {
    let Some(object) = reply.as_object() else {
        return Err(ERROR_REJECTED.into());
    };
    match object.get("ok") {
        Some(Value::Bool(true)) => object
            .get("result")
            .cloned()
            .ok_or_else(|| ERROR_REJECTED.to_owned()),
        Some(Value::Bool(false)) => {
            let Some(error) = object.get("error").and_then(Value::as_object) else {
                return Err(ERROR_REJECTED.into());
            };
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(ERROR_REJECTED);
            Err(format!("{} failed ({code}): {message}", intent.method))
        }
        _ => Err(ERROR_REJECTED.into()),
    }
}

#[cfg(test)]
#[path = "app_control_tests.rs"]
mod tests;
