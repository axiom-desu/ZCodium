use crate::{
    completion::Completion,
    draft_attachments::DraftAttachments,
    editor::{Editor, sanitize},
    file_mentions::FileMentions,
    input_history::History,
    operations::Operations,
    selector::Selector,
    telemetry::Telemetry,
};
use serde_json::Value;

pub(crate) const MAX_ROWS: usize = 2000;
pub(crate) const MAX_FIELD_BYTES: usize = 16 * 1024;
pub(crate) const MAX_RENDER_BYTES: usize = 512 * 1024;
const MAX_NOTICE_BYTES: usize = 4 * 1024;
const TRUNCATED: &str = "…[display truncated]";

/// Truncate at a UTF-8 boundary and reserve room for a visible UI-only marker.
fn bounded(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let marker = if limit >= TRUNCATED.len() {
        TRUNCATED
    } else if limit >= '…'.len_utf8() {
        "…"
    } else {
        ""
    };
    let end = limit.saturating_sub(marker.len()).min(value.len());
    let end = (0..=end)
        .rev()
        .find(|i| value.is_char_boundary(*i))
        .unwrap_or(0);
    format!("{}{marker}", &value[..end])
}

/// actor 的“正在运行”事实：phase 与 canStop 任一为真即为运行中。
fn running(control: &Value) -> bool {
    control["phase"] == "running" || control["canStop"] == true
}

fn append_bounded(current: &str, append: &str, limit: usize) -> String {
    if current.len().saturating_add(append.len()) <= limit {
        return format!("{current}{append}");
    }
    let marker = if limit >= TRUNCATED.len() {
        TRUNCATED
    } else {
        "…"
    };
    let content_limit = limit.saturating_sub(marker.len());
    let mut result = String::with_capacity(limit);
    for value in [current, append] {
        let remaining = content_limit.saturating_sub(result.len());
        if remaining == 0 {
            break;
        }
        let end = remaining.min(value.len());
        let end = (0..=end)
            .rev()
            .find(|i| value.is_char_boundary(*i))
            .unwrap_or(0);
        result.push_str(&value[..end]);
    }
    result.push_str(marker);
    result
}

pub(crate) fn bound_row(row: &mut Value) {
    for path in ["text", "inputText", "output.text", "error.message"] {
        let mut target = &mut *row;
        let mut parts = path.split('.').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                if let Some(value) = target.get(part).and_then(Value::as_str) {
                    *target.get_mut(part).expect("field exists") =
                        bounded(value, MAX_FIELD_BYTES).into();
                }
            } else {
                target = &mut target[part];
            }
        }
    }
}

/// 正在等待 actor 回包的非阻塞操作：纯 UI 派生摘要，不是新的服务端事实 owner。
///
/// 只由 `Client` 的 workflow/draft 状态每轮投影到 View，帮助用户分辨“命令还在打开/应用/
/// 保存”与“命令被静默丢弃”。真实结果仍由 actor 回包结算。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pending {
    /// boot / 会话切换（list → resume/create → topicOpen → snapshot）。
    Opening,
    /// setter + 同一 workflow 的快照续步。
    Setting,
    /// 队列 mutation + 快照续步。
    Queue,
    /// `/sessions` 的只读列表。
    Sessions,
    /// gaprepair 只读快照。
    Syncing,
    /// compact 等一次性 Command workflow。
    Command,
    /// 已发送、等待 actor admission/结果的正文 mutation。
    Submitting,
}

impl Pending {
    pub(crate) fn text(self, zh: bool) -> &'static str {
        match (self, zh) {
            (Self::Opening, false) => "Opening session...",
            (Self::Opening, true) => "正在打开会话...",
            (Self::Setting, false) => "Applying setting...",
            (Self::Setting, true) => "正在应用设置...",
            (Self::Queue, false) => "Saving queue change...",
            (Self::Queue, true) => "正在保存队列变更...",
            (Self::Sessions, false) => "Loading sessions...",
            (Self::Sessions, true) => "正在加载会话...",
            (Self::Syncing, false) => "Refreshing session...",
            (Self::Syncing, true) => "正在刷新会话...",
            (Self::Command, false) => "Waiting for the actor...",
            (Self::Command, true) => "正在等待 actor...",
            (Self::Submitting, false) => "Waiting for the actor...",
            (Self::Submitting, true) => "正在等待 actor...",
        }
    }
}

/// A disposable terminal projection; accepted input/session facts live in Engine.
#[derive(Default)]
pub(crate) struct View {
    pub session: String,
    pub rows: Vec<Value>,
    pub state: Value,
    pub seq: u64,
    pub notices: Vec<String>,
    pub editor: Editor,
    pub completion: Completion,
    pub file_mentions: FileMentions,
    pub draft_attachments: DraftAttachments,
    /// 输入历史游标：只保存本地草稿/条目位置，历史事实仍由 store 持有。
    pub history: History,
    pub scroll: usize,
    pub follow: bool,
    pub pending_submit: bool,
    /// 非阻塞 UI mutation 状态机：唯一在飞 workflow、SentDraft owner 与拒绝草稿槽。
    pub operations: Operations,
    pub resync: bool,
    pub zh: bool,
    pub models: Vec<Value>,
    pub selector: Option<Selector>,
    /// 队列编辑草稿：独立于 main editor，权限/问答期间不得当答案。
    pub queue_edit: Option<crate::queue::QueueEdit>,
    pub sidebar: bool,
    pub sidebar_overlay: bool,
    /// 读票据归属：切 session / TopicClosed 时递增，旧 generation 的 reply 必须丢弃。
    pub generation: u64,
    /// UI 镜像事实：TopicClosed 后为 true，本地拒绝普通提交，成功 snapshot/open 解除。
    pub topic_closed: bool,
    /// MCP/usage 的可丢弃展示投影；事实仍由 MCP Hub 与 core actor 持有。
    pub telemetry: Telemetry,
    pub no_color: bool,
    pub directory: String,
    pub display_revision: u64,
    /// 每轮由 `Client` 从在飞 workflow/draft 派生的可见摘要；绝不持久化、不回传 actor。
    pub pending: Option<Pending>,
}
impl View {
    pub fn text<'a>(&self, en: &'a str, zh: &'a str) -> &'a str {
        if self.zh { zh } else { en }
    }
    /// 补全只看本地草稿：选择器、审批问答或 busy 时不展示，避免抢走原交互。
    pub fn completion_enabled(&self) -> bool {
        self.selector.is_none() && self.interaction().is_none() && !self.busy()
    }
    /// 每个真实键/paste/快照后收敛补全；不引入计时器或第二份草稿。
    pub fn sync_completion(&mut self) {
        let enabled = self.completion_enabled();
        self.completion.reconcile(self.editor.text(), enabled);
    }
    /// Tab/Enter 的写回动作：只改编辑器，不发送命令、不建 accepted 队列。
    pub fn accept_completion(&mut self) {
        if let Some(replacement) = self.completion.replacement() {
            self.editor.replace_all(&replacement);
        }
    }
    pub fn push(&mut self, text: &str) {
        self.display_revision = self.display_revision.wrapping_add(1);
        self.notices
            .push(bounded(&sanitize(text), MAX_NOTICE_BYTES));
        if self.notices.len() > 40 {
            self.notices.remove(0);
        }
    }
    pub fn mode(&self) -> &str {
        // Plan 是 actor 的独立标记；只显示 permission mode 会把已经启用的 plan 错写成 build。
        if self.state["config"]["planEnabled"] == true {
            "plan"
        } else {
            self.state["config"]["mode"].as_str().unwrap_or("—")
        }
    }
    pub fn busy(&self) -> bool {
        self.pending_submit || self.state["control"]["canStop"] == true
    }
    pub fn deltas(
        &mut self,
        session: &str,
        from: u64,
        to: u64,
        deltas: impl Iterator<Item = Value>,
    ) {
        if session != self.session || to <= self.seq {
            return;
        }
        if from != self.seq {
            self.resync = true;
            return;
        }
        for delta in deltas {
            self.delta(&delta);
        }
        self.seq = to;
        self.display_revision = self.display_revision.wrapping_add(1);
    }
    fn delta(&mut self, delta: &Value) {
        match delta["op"].as_str().unwrap_or_default() {
            "row.appended" | "row.upserted" => {
                let mut row = delta["row"].clone();
                bound_row(&mut row);
                if let Some(index) = self.rows.iter().position(|r| r["rowId"] == row["rowId"]) {
                    self.rows[index] = row;
                } else {
                    self.rows.push(row);
                }
            }
            "row.delta" if delta["path"] == "text" => {
                if let Some(row) = self.rows.iter_mut().find(|r| r["rowId"] == delta["rowId"]) {
                    if let (Some(current), Some(append)) =
                        (row["text"].as_str(), delta["append"].as_str())
                    {
                        // 持续流式 append 也只能增长到单字段预算；超出部分仅影响 UI。
                        row["text"] = append_bounded(current, append, MAX_FIELD_BYTES).into();
                    }
                } else {
                    self.resync = true;
                }
            }
            "row.removed" => self.rows.retain(|r| r["rowId"] != delta["rowId"]),
            "state.updated" => {
                if let Some(patch) = delta["patch"].as_object() {
                    let was_running = running(&self.state["control"]);
                    for (key, value) in patch {
                        self.state[key] = value.clone();
                    }
                    // 一轮真实结束必须在这里就置位：`Client::call` 可能在同一批里消费
                    // running 和 completed，主循环只看到末态，pump 自己比较 phase 会漏刷新。
                    if was_running && !running(&self.state["control"]) {
                        self.telemetry.mcp_dirty = true;
                    }
                    // control.updated 是事实投影，不能清掉仍在飞的 draft overlay；
                    // pending 只由真实 operation 结算/派生。
                    if patch.contains_key("control") && !self.operations.busy() {
                        self.pending_submit = false;
                    }
                }
            }
            _ => {}
        }
        // Bound only the display window, never mutate or truncate persisted history.
        if self.rows.len() > MAX_ROWS {
            self.rows.drain(..self.rows.len() - MAX_ROWS);
        }
    }
    pub fn interaction(&self) -> Option<&Value> {
        self.state["pendingInteractions"].as_array()?.first()
    }
    #[cfg(test)]
    pub fn lines(&self) -> Vec<String> {
        // 先为错误和最新通知留出预算，再用剩余空间展示最新会话行；这样旧历史
        // 再长也不会挤掉本轮回复或错误提示。最终顺序仍按时间从旧到新输出。
        let alert_budget = MAX_RENDER_BYTES / 4;
        let mut alerts = Vec::new();
        let mut alert_used = 0usize;
        if let Some(message) = self.state["control"]["lastError"]["message"].as_str() {
            alerts.push(format!("Error: {}", bounded(message, MAX_FIELD_BYTES)));
        }
        if self.state["control"]["phase"] == "completedInterrupted" {
            alerts.push(self.text("Turn cancelled", "运行已取消").to_owned());
        }
        for notice in self.notices.iter().rev() {
            alerts.push(notice.clone());
        }
        let mut selected_alerts = Vec::new();
        for alert in alerts {
            let cost = alert.len().saturating_add(1);
            if alert_used.saturating_add(cost) > alert_budget {
                continue;
            }
            alert_used += cost;
            selected_alerts.push(alert);
        }
        selected_alerts.reverse();

        let row_budget = MAX_RENDER_BYTES - alert_used;
        let mut newest_rows = Vec::new();
        let mut row_used = 0usize;
        for row in self.rows.iter().rev() {
            let kind = row["kind"].as_str().unwrap_or_default();
            let name = match kind {
                "userQuery" => self.text("You", "你"),
                "assistantText" => self.text("Assistant", "助手"),
                "reasoning" => self.text("Thinking", "思考"),
                "toolCall" => row["toolName"].as_str().unwrap_or("Tool"),
                _ => kind,
            };
            let text = if kind == "toolCall" {
                format!(
                    "{} [{}]\n{}\n{}",
                    name,
                    row["status"].as_str().unwrap_or(""),
                    row["inputText"].as_str().unwrap_or(""),
                    row["output"]["text"]
                        .as_str()
                        .or(row["error"]["message"].as_str())
                        .unwrap_or("")
                )
            } else {
                format!("{name}: {}", row["text"].as_str().unwrap_or(""))
            };
            let mut rendered = sanitize(&text)
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            rendered.push(String::new());
            let cost = rendered.iter().map(|line| line.len() + 1).sum::<usize>();
            if row_used.saturating_add(cost) > row_budget {
                break;
            }
            row_used += cost;
            newest_rows.push(rendered);
        }
        let mut lines = Vec::new();
        for row in newest_rows.into_iter().rev() {
            lines.extend(row);
        }
        lines.extend(selected_alerts);
        lines
    }
}
