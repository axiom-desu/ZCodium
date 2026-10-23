//! MCP / usage 只读遥测（spec cli-rust-tui-workbench §3）。
//!
//! `Telemetry` 只保存可丢弃的查询投影：MCP Hub 独占连接状态，core actor 独占 usage 事实。
//! 这里不 connect、不重启 server、不引入超时或定时器；唯一触发点是首次加载、轮次结束、
//! 侧栏重新可见和显式 `/mcp`。`/usage` 走核心现有的 `session/usage`。
use crate::{
    client::{Client, QueryKind, ReadReply},
    projection::View,
    transport::Request,
};
use serde_json::{Value, json};
use zcode_cli_core_api::Method;

/// 侧栏最多展示 5 台服务器；缓存略多但仍严格有界，用于“更多 N”计数。
pub(crate) const MAX_SERVER_ROWS: usize = 5;
const MAX_STORED_SERVERS: usize = 32;
const TOKEN_KILO: u64 = 1_000;
const TOKEN_MEGA: u64 = 1_000_000;
/// MCP Hub 真实会回报的状态值；未知值是坏报文，不能当成功行展示。
const VALID_STATUSES: [&str; 6] = [
    "connecting",
    "connected",
    "disabled",
    "disconnected",
    "failed",
    "untrusted",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpServer {
    pub name: String,
    pub status: String,
    pub transport: String,
    /// 缺失即未知：不能编一个 0 顶替真实工具数。
    pub tool_count: Option<u64>,
    pub failure_kind: Option<String>,
    pub error: Option<String>,
}

/// 一次成功回包的完整统计：缓存前 `MAX_STORED_SERVERS` 个细项，计数仍取完整 map。
struct McpStatus {
    servers: Vec<McpServer>,
    total: usize,
    connected: usize,
}

/// `session/usage` 的真实累计数；不能拿来顶替 context window。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Usage {
    pub total: u64,
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Telemetry {
    pub mcp_loading: bool,
    /// 已排序服务器细项的有界缓存（最多 `MAX_STORED_SERVERS`）。
    pub mcp_servers: Vec<McpServer>,
    /// 完整 `statuses` map 的真实总数；摘要不能只看缓存。
    pub mcp_total: usize,
    /// 完整 map 中真实 connected 数量。
    pub mcp_connected: usize,
    pub mcp_error: Option<String>,
    /// 是否有待发送的 MCP 查询；只有显式时机才置位，避免 50ms 重绘风暴。
    pub mcp_dirty: bool,
    /// 上一次观察到的侧栏可见性，用于识别“重新可见”。
    pub mcp_visible: bool,
    /// 至少成功应用过一次状态；空结果也算已知，但不能因此显示为已连接。
    pub mcp_loaded: bool,
    pub usage: Option<Usage>,
    pub usage_loading: bool,
    pub usage_error: Option<String>,
}

impl Telemetry {
    /// 切 session / TopicClosed：旧查询事实不能挂到新 generation，重新进入同 id 也一样。
    pub(crate) fn reset(&mut self) {
        *self = Self {
            mcp_dirty: true,
            ..Self::default()
        };
    }
}

/// 当前 sidebar 是否可见（宽屏分栏或窄屏 overlay）。
fn visible(view: &View) -> bool {
    view.sidebar || view.sidebar_overlay
}

/// 主循环每个 tick 调用：只处理已到期的 MCP 刷新时机，绝不阻塞键盘/退出。
pub(crate) fn pump(client: &mut Client<'_>, view: &mut View, request: &Request) {
    let visible = visible(view);
    if visible && !view.telemetry.mcp_visible {
        // 侧栏重新可见只触发一次；隐藏时不轮询。
        view.telemetry.mcp_dirty = true;
    }
    view.telemetry.mcp_visible = visible;

    if !view.telemetry.mcp_dirty {
        return;
    }
    let params = json!({"workspace": request.workspace, "mode": "status"});
    match client.start_query(view, QueryKind::McpStatus, Method::McpList, params) {
        Ok(true) => {
            view.telemetry.mcp_dirty = false;
            // 刷新成功前保留 last known；只有完全没有数据时才展示 loading。
            if view.telemetry.mcp_servers.is_empty() {
                view.telemetry.mcp_loading = true;
            }
        }
        // 在飞或有未消费结果：本 tick 不发请求，下一轮再看。
        Ok(false) => {}
        Err(error) => {
            view.telemetry.mcp_dirty = false;
            view.telemetry.mcp_loading = false;
            view.telemetry.mcp_error = Some(error.to_string());
            view.push(view.text("MCP status query failed.", "MCP 状态查询失败。"));
        }
    }
}

/// 显式 `/mcp`：强制一次只读刷新，仍复用 pump 的唯一发送路径。
pub(crate) fn request_mcp(client: &mut Client<'_>, view: &mut View, request: &Request) {
    view.telemetry.mcp_dirty = true;
    pump(client, view, request);
}

/// 显式 `/usage`：非阻塞地请求真实累计数，结果与错误都以 notice 显式呈现。
pub(crate) fn request_usage(client: &mut Client<'_>, view: &mut View) -> anyhow::Result<()> {
    let params = json!({"sessionId": view.session.clone()});
    if client.start_query(view, QueryKind::Usage, Method::SessionUsage, params)? {
        view.telemetry.usage_loading = true;
        view.telemetry.usage_error = None;
    } else {
        view.push(view.text("Usage query is already in flight.", "用量查询已在进行中。"));
    }
    Ok(())
}

/// 只处理本模块的读结果；history 由前端集成模块分流。应用前再验证 session + generation。
pub(crate) fn apply_reply(view: &mut View, reply: ReadReply) {
    if reply.session != view.session || reply.generation != view.generation {
        // 迟到/旧会话结果：不能覆盖新 generation 的展示。
        return;
    }
    match reply.kind {
        QueryKind::McpStatus => apply_mcp(view, reply.result),
        QueryKind::Usage => apply_usage(view, reply.result),
        QueryKind::History { .. } => {}
    }
}

fn apply_mcp(view: &mut View, result: Result<Value, zcode_cli_core_api::RuntimeError>) {
    view.telemetry.mcp_loading = false;
    // dirty 不在这里清：pump 在发送时已清过一次，应用期间新产生的触发（如轮次结束）
    // 必须留到下一轮补发一次，否则在飞的旧请求会吃掉这次刷新。
    match result {
        Ok(value) => match statuses(&value) {
            Ok(status) => {
                // 空 statuses 是“没有已配置服务器”，不是“全部已连接”。
                view.telemetry.mcp_servers = status.servers;
                view.telemetry.mcp_total = status.total;
                view.telemetry.mcp_connected = status.connected;
                view.telemetry.mcp_error = None;
                view.telemetry.mcp_loaded = true;
            }
            Err(detail) => mcp_failure(view, detail),
        },
        Err(error) => mcp_failure(view, error.to_string()),
    }
}

/// 坏报文/失败：保留 last known + 可见错误，不能变成永绿，也不能悄悄清空。
fn mcp_failure(view: &mut View, detail: String) {
    view.telemetry.mcp_error = Some(detail.clone());
    view.push(&format!(
        "{} {detail}",
        view.text("MCP status refresh failed:", "MCP 状态刷新失败："),
    ));
}

fn apply_usage(view: &mut View, result: Result<Value, zcode_cli_core_api::RuntimeError>) {
    view.telemetry.usage_loading = false;
    let outcome = match result {
        Ok(value) => usage(&value, &view.session),
        Err(error) => Err(error.to_string()),
    };
    match outcome {
        Ok(usage) => {
            view.telemetry.usage = Some(usage);
            view.telemetry.usage_error = None;
            view.push(&format!(
                "{} {} {} · {} {} · {} {}",
                view.text("Usage:", "用量："),
                compact_tokens(usage.total),
                view.text("total", "总计"),
                compact_tokens(usage.input),
                view.text("input", "输入"),
                compact_tokens(usage.output),
                view.text("output", "输出"),
            ));
        }
        Err(detail) => {
            // 失败保留上一次真实数字；语义不是 nil → 0。
            view.telemetry.usage_error = Some(detail.clone());
            view.push(&format!(
                "{} {detail}",
                view.text("Usage query failed:", "用量查询失败："),
            ));
        }
    }
}

/// 校验 `{statuses: {name: {status, transport?, toolCount?}}}`；无效报文整个拒绝。
fn statuses(value: &Value) -> Result<McpStatus, String> {
    let map = value["statuses"]
        .as_object()
        .ok_or_else(|| "MCP status reply has no statuses object".to_owned())?;
    let mut servers = Vec::with_capacity(map.len().min(MAX_STORED_SERVERS));
    let mut connected = 0;
    for (name, status) in map {
        if !status.is_object() {
            return Err(format!("server {name} has an invalid status entry"));
        }
        let kind = status["status"]
            .as_str()
            .ok_or_else(|| format!("server {name} has no status"))?;
        if !VALID_STATUSES.contains(&kind) {
            return Err(format!("server {name} reported unknown status {kind}"));
        }
        if kind == "connected" {
            connected += 1;
        }
        let transport = match status.get("transport") {
            None | Some(Value::Null) => "—".to_owned(),
            Some(value) => value
                .as_str()
                .ok_or_else(|| format!("server {name} has an invalid transport"))?
                .to_owned(),
        };
        // 缺失是“未知”，类型不对是坏报文；两者都不能补 0。
        let tool_count = match status.get("toolCount") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .ok_or_else(|| format!("server {name} has an invalid toolCount"))?,
            ),
        };
        servers.push(McpServer {
            name: name.clone(),
            status: kind.to_owned(),
            transport,
            tool_count,
            failure_kind: status["failureKind"].as_str().map(str::to_owned),
            error: status["error"].as_str().map(str::to_owned),
        });
    }
    servers.sort_by(|left, right| left.name.cmp(&right.name));
    let total = map.len();
    // 缓存只保留前 32 个细项；摘要与“更多”用上面统计的真实 total/connected。
    servers.truncate(MAX_STORED_SERVERS);
    Ok(McpStatus {
        servers,
        total,
        connected,
    })
}

/// 真实 usage 回包：必须带同会话 id 与全部计数；任何缺失都是错误，不按 0 累计。
fn usage(value: &Value, session: &str) -> Result<Usage, String> {
    let id = value["sessionId"]
        .as_str()
        .ok_or_else(|| "usage reply has no sessionId".to_owned())?;
    if id != session {
        return Err(format!("usage reply belongs to session {id}"));
    }
    Ok(Usage {
        total: count(value, "totalTokens")?,
        input: count(value, "inputTokens")?,
        output: count(value, "outputTokens")?,
        reasoning: count(value, "reasoningTokens")?,
        cache_read: count(value, "cacheReadTokens")?,
        cache_write: count(value, "cacheCreationTokens")?,
    })
}

fn count(value: &Value, field: &str) -> Result<u64, String> {
    value[field]
        .as_u64()
        .ok_or_else(|| format!("usage reply has no numeric {field}"))
}

/// 与 TS `formatCompactTokenCount` 一致：<1K 原样，K/M 保留一位小数并去掉 `.0`。
pub(crate) fn compact_tokens(value: u64) -> String {
    if value < TOKEN_KILO {
        return value.to_string();
    }
    if value < TOKEN_MEGA {
        return format!("{}K", decimal(value as f64 / TOKEN_KILO as f64));
    }
    format!("{}M", decimal(value as f64 / TOKEN_MEGA as f64))
}

fn decimal(value: f64) -> String {
    let text = format!("{value:.1}");
    text.strip_suffix(".0").unwrap_or(&text).to_owned()
}
