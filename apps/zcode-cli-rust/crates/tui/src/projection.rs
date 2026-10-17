use crate::editor::{Editor, sanitize};
use serde_json::Value;

const MAX_ROWS: usize = 2000;
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

fn bound_row(row: &mut Value) {
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

/// A disposable terminal projection; accepted input/session facts live in Engine.
#[derive(Default)]
pub(crate) struct View {
    pub session: String,
    pub rows: Vec<Value>,
    pub state: Value,
    pub seq: u64,
    pub notices: Vec<String>,
    pub editor: Editor,
    pub scroll: usize,
    pub follow: bool,
    pub pending_submit: bool,
    pub resync: bool,
    pub zh: bool,
    pub models: Vec<Value>,
}
impl View {
    pub fn text<'a>(&self, en: &'a str, zh: &'a str) -> &'a str {
        if self.zh { zh } else { en }
    }
    pub fn push(&mut self, text: &str) {
        self.notices
            .push(bounded(&sanitize(text), MAX_NOTICE_BYTES));
        if self.notices.len() > 40 {
            self.notices.remove(0);
        }
    }
    pub fn busy(&self) -> bool {
        self.pending_submit || self.state["control"]["canStop"] == true
    }
    pub fn snapshot(&mut self, snapshot: &Value) {
        self.session = snapshot["sessionId"].as_str().unwrap_or_default().into();
        self.rows = snapshot["rows"]["window"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for row in &mut self.rows {
            bound_row(row);
        }
        if self.rows.len() > MAX_ROWS {
            self.rows.drain(..self.rows.len() - MAX_ROWS);
        }
        self.seq = snapshot["seq"].as_u64().unwrap_or(0);
        self.state = snapshot.clone();
        if let Some(state) = self.state.as_object_mut() {
            state.remove("rows");
        }
        self.resync = false;
        self.pending_submit = false;
        self.follow = true;
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
                    for (key, value) in patch {
                        self.state[key] = value.clone();
                    }
                    if patch.contains_key("control") {
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
