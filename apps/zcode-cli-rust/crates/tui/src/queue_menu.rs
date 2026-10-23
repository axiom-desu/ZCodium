//! 队列选择器菜单：typed 项列表 → 操作菜单，以及各操作的既有 payload。
use crate::{
    projection::View,
    queue_state::{self, QueueChoice, QueueOp},
    selector::{Choice, Selector},
};
use anyhow::{Context, Result};
use serde_json::{Value, json};

/// 第一步：把当前 actor 队列投影成 typed 选择列表（id + 捕获的 CAS 基线）。
pub(crate) fn open(view: &View) -> Result<Selector> {
    let revision = queue_state::revision(view);
    let log_epoch = queue_state::log_epoch(view);
    let options = queue_state::items(view)
        .iter()
        .filter_map(|item| {
            let id = item["queueItemId"].as_str()?;
            Some((
                Choice::Queue(QueueChoice {
                    queue_item_id: id.to_owned(),
                    op: None,
                    revision,
                    log_epoch: log_epoch.clone(),
                }),
                item_label(item),
            ))
        })
        .collect::<Vec<_>>();
    Selector::new(
        view.text("Queued inputs", "排队输入").to_owned(),
        options,
        view.session.clone(),
        view.editor.text().to_owned(),
    )
    .with_context(|| {
        queue_state::local(
            view,
            "The queue is empty.".into(),
            "当前没有排队输入。".into(),
        )
    })
}

/// 第二步：为指定排队项打开操作菜单（只列出 actor 允许的操作）。
pub(crate) fn menu(view: &View, choice: &QueueChoice) -> Result<Selector> {
    let Some(item) = queue_state::find(view, &choice.queue_item_id) else {
        return Err(queue_state::stale(view, &choice.queue_item_id));
    };
    queue_state::ensure_queued(view, item)?;
    let zh = view.zh;
    let mut options = Vec::new();
    if queue_state::ensure_editable(view, item).is_ok() {
        options.push(entry(choice, QueueOp::Edit, zh));
    }
    if queue_state::availability(view, "sendQueuedNow").is_ok() {
        options.push(entry(choice, QueueOp::Send, zh));
    }
    if queue_state::reorder_before(view, &choice.queue_item_id, true).is_ok() {
        options.push(entry(choice, QueueOp::Up, zh));
    }
    if queue_state::reorder_before(view, &choice.queue_item_id, false).is_ok() {
        options.push(entry(choice, QueueOp::Down, zh));
    }
    options.push(entry(choice, QueueOp::Delete, zh));
    Selector::new(
        item_label(item),
        options,
        view.session.clone(),
        view.editor.text().to_owned(),
    )
    .with_context(|| {
        queue_state::local(
            view,
            "No queue action is available for this item.".into(),
            "该排队项当前没有可用操作。".into(),
        )
    })
}

fn entry(choice: &QueueChoice, op: QueueOp, zh: bool) -> (Choice, String) {
    (Choice::Queue(choice.with_op(op)), op.label(zh).to_owned())
}

fn item_label(item: &Value) -> String {
    let id = item["queueItemId"].as_str().unwrap_or("?");
    let kind = item["kind"].as_str().unwrap_or("sendText");
    let state = item["dispatch"]["state"].as_str().unwrap_or("queued");
    let text = item["text"]
        .as_str()
        .unwrap_or("")
        .replace(['\n', '\r'], " ");
    let text = text.chars().take(80).collect::<String>();
    if state == "queued" {
        format!("{id} · {kind} · {text}")
    } else {
        format!("{id} · {kind} · {state} · {text}")
    }
}

/// 操作 payload 只描述目标与顺序；附件/选型仍由 actor 从 accepted item 读取。
pub(crate) fn payload(view: &View, choice: &QueueChoice, op: QueueOp) -> Result<Value> {
    match op {
        // Edit 由 start_edit + commit 处理；这里只覆盖其余 mutation 的既有 payload。
        QueueOp::Edit => unreachable!("edit is committed from the local QueueEdit draft"),
        QueueOp::Delete => Ok(json!({"queueItemId":choice.queue_item_id})),
        QueueOp::Send => {
            queue_state::availability(view, "sendQueuedNow")?;
            Ok(json!({"queueItemId":choice.queue_item_id}))
        }
        QueueOp::Up | QueueOp::Down => {
            let before =
                queue_state::reorder_before(view, &choice.queue_item_id, op == QueueOp::Up)?;
            Ok(json!({"queueItemId":choice.queue_item_id,"beforeQueueItemId":before}))
        }
    }
}
