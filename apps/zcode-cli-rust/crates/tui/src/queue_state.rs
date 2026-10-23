//! 队列菜单的 typed 选择项与只读快照投影。
//!
//! actor snapshot 是 accepted queue 的唯一事实来源：这里只把 `state.queue.items`
//! 投影成 typed id + 捕获的 revision/logEpoch，绝不按过滤后行号推断 id、不复制
//! 第二份队列，也不在本地增删 `state.queue.items`。
use crate::{editor::Editor, projection::View};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

/// composer 上方最多展示的排队项行数（超出部分只给数量）。
pub(crate) const VISIBLE_ITEMS: usize = 3;

/// 队列菜单里的一项操作；token 同时是 `/queue <token> <id>` 的入口。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueueOp {
    Edit,
    Delete,
    Send,
    Up,
    Down,
}

impl QueueOp {
    pub(crate) fn token(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::Delete => "delete",
            Self::Send => "send",
            Self::Up => "up",
            Self::Down => "down",
        }
    }
    pub(crate) fn from_token(token: &str) -> Option<Self> {
        [Self::Edit, Self::Delete, Self::Send, Self::Up, Self::Down]
            .into_iter()
            .find(|op| op.token() == token)
    }
    /// 共享 v4 command kind；sendNow 只能提升指定 id，不等于运行整条暂停队列。
    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::Edit => "editQueueItem",
            Self::Delete => "deleteQueueItem",
            Self::Send => "sendQueuedNow",
            Self::Up | Self::Down => "reorderQueueItem",
        }
    }
    pub(crate) fn label(self, zh: bool) -> &'static str {
        match (self, zh) {
            (Self::Edit, false) => "Edit text",
            (Self::Edit, true) => "编辑正文",
            (Self::Delete, false) => "Delete",
            (Self::Delete, true) => "删除",
            (Self::Send, false) => "Send now",
            (Self::Send, true) => "立即发送",
            (Self::Up, false) => "Move up",
            (Self::Up, true) => "上移",
            (Self::Down, false) => "Move down",
            (Self::Down, true) => "下移",
        }
    }
}

/// 队列选择器的 typed 载体：`op == None` 是第一步选 queue 项，`Some` 是第二步选操作。
///
/// revision/logEpoch 在打开菜单时捕获并随项一起传递，提交时原样进 `Method::Command`
/// 的 CAS 字段；任何一步都不能用过滤列表下标代表队列项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QueueChoice {
    pub(crate) queue_item_id: String,
    pub(crate) op: Option<QueueOp>,
    pub(crate) revision: u64,
    pub(crate) log_epoch: String,
}

impl QueueChoice {
    pub(crate) fn with_op(&self, op: QueueOp) -> Self {
        Self {
            op: Some(op),
            ..self.clone()
        }
    }
    /// filter 额外匹配稳定 id 与操作名，便于多队列按 id 精确定位。
    pub(crate) fn searchable(&self) -> String {
        match self.op {
            Some(op) => format!("{} {}", self.queue_item_id, op.token()),
            None => self.queue_item_id.clone(),
        }
    }
}

/// 独立于 main editor 的队列编辑草稿。
///
/// main editor 在权限/问答期间专门用于回答，队列编辑文本必须留在自己这里，
/// 否则审批会拿排队正文当答案。附件只读保留原项投影，不改 schema、不读磁盘。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QueueEdit {
    pub(crate) session: String,
    /// 读票据世代：切 session / TopicClosed 后旧编辑必须失效。
    pub(crate) generation: u64,
    pub(crate) queue_item_id: String,
    pub(crate) revision: u64,
    pub(crate) log_epoch: String,
    /// 原项 kind（compact 等不可编辑约束的展示来源）。
    pub(crate) kind: String,
    pub(crate) editor: Editor,
    /// 原项附件只读投影：编辑正文不改附件契约。
    pub(crate) attachments: Value,
}

impl QueueEdit {
    pub(crate) fn from_item(
        view: &View,
        item: &Value,
        revision: u64,
        log_epoch: &str,
    ) -> QueueEdit {
        let mut editor = Editor::default();
        editor.replace_all(item["text"].as_str().unwrap_or_default());
        QueueEdit {
            session: view.session.clone(),
            generation: view.generation,
            queue_item_id: item["queueItemId"].as_str().unwrap_or_default().to_owned(),
            revision,
            log_epoch: log_epoch.to_owned(),
            kind: item["kind"].as_str().unwrap_or("sendText").to_owned(),
            editor,
            attachments: item
                .get("attachments")
                .cloned()
                .unwrap_or_else(|| json!([])),
        }
    }
    pub(crate) fn text(&self) -> &str {
        self.editor.text()
    }
}

/// actor 快照中的排队项；空/缺字段是明确的“没有排队项”，不编造本地项。
pub(crate) fn items(view: &View) -> &[Value] {
    view.state["queue"]["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
}

pub(crate) fn revision(view: &View) -> u64 {
    view.state["revision"].as_u64().unwrap_or(0)
}

pub(crate) fn log_epoch(view: &View) -> String {
    view.state["logEpoch"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

/// autoDrain 来自 actor：false 就是“队列已暂停”，不根据队列非空猜测。
pub(crate) fn auto_drain(view: &View) -> bool {
    view.state["queue"]["autoDrain"] == true
}

pub(crate) fn find<'a>(view: &'a View, id: &str) -> Option<&'a Value> {
    items(view)
        .iter()
        .find(|item| item["queueItemId"].as_str() == Some(id))
}

/// 本地错误（不发模型）：双语、明确，且保留原草稿/选择器给用户重试。
pub(crate) fn local(view: &View, en: String, zh: String) -> anyhow::Error {
    anyhow::anyhow!("{}", if view.zh { zh } else { en })
}

/// 目标 id 不在当前快照里：本地拒绝，绝不按菜单位置猜最新 id。
pub(crate) fn stale(view: &View, id: &str) -> anyhow::Error {
    local(
        view,
        format!("Queued input {id} is gone. Reopen /queue to see the current queue."),
        format!("排队输入 {id} 已不存在。请重新打开 /queue 查看当前队列。"),
    )
}

/// 队列项被 actor 预留/提升中：任何 mutation 都先本地拒绝。
pub(crate) fn ensure_queued(view: &View, item: &Value) -> Result<()> {
    let state = item["dispatch"]["state"].as_str().unwrap_or_default();
    ensure!(
        state == "queued",
        "{}",
        if view.zh {
            format!("排队项正在处理中（{state}），暂不可操作。")
        } else {
            format!("Queued input is {state}; it cannot be changed right now.")
        }
    );
    Ok(())
}

/// edit 额外要求：kind 可编辑 + actor 给出的 `queueEdit` availability。
pub(crate) fn ensure_editable(view: &View, item: &Value) -> Result<()> {
    let kind = item["kind"].as_str().unwrap_or("sendText");
    ensure!(
        kind != "compact",
        "{}",
        local(
            view,
            "Compaction entries cannot be edited; delete it instead.".into(),
            "压缩条目不可编辑，请改为删除。".into(),
        )
    );
    availability(view, "queueEdit")
}

/// availability 门禁：拒绝时原样带出 actor 的 reasonCode，不自行降级或重试。
pub(crate) fn availability(view: &View, key: &str) -> Result<()> {
    let gate = &view.state["availability"][key];
    if gate["allowed"] == true {
        return Ok(());
    }
    let reason = gate["reasonCode"]
        .as_str()
        .unwrap_or("guard.capabilityUnsupported");
    Err(local(
        view,
        format!("Queue action unavailable ({reason})."),
        format!("队列操作当前不可用（{reason}）。"),
    ))
}

/// 重排锚点：按当前快照里的相邻 id 计算，多队列也不会按陈旧下标移动。
///
/// `beforeQueueItemId == null` 表示移到队尾；无法移动是本地 noop 错误。
pub(crate) fn reorder_before(view: &View, id: &str, up: bool) -> Result<Option<String>> {
    let items = items(view);
    let position = items
        .iter()
        .position(|item| item["queueItemId"].as_str() == Some(id))
        .with_context(|| format!("queued input {id} is gone"))?;
    if up {
        ensure!(
            position > 0,
            "{}",
            local(
                view,
                "This queued input is already first.".into(),
                "该排队项已在队首。".into()
            )
        );
        return Ok(items[position - 1]["queueItemId"]
            .as_str()
            .map(str::to_owned));
    }
    ensure!(
        position + 1 < items.len(),
        "{}",
        local(
            view,
            "This queued input is already last.".into(),
            "该排队项已在队尾。".into()
        )
    );
    Ok(items
        .get(position + 2)
        .and_then(|item| item["queueItemId"].as_str())
        .map(str::to_owned))
}
