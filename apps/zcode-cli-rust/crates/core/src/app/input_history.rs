//! Input history of accepted root prompts (spec cli-rust-tui-workbench §1).
//! The actor is the only writer: it queues one journal op right after the
//! admission row, so the store commits input, ACK and history together.
use super::Engine;
use crate::contract::RuntimeError;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use zcode_cli_domain::node_journal::InputHistory;

/// The user's own text and the attachments as they were submitted, captured
/// before `prepare_attachments` rewrites the refs into session artifacts.
pub(super) struct Raw {
    text: String,
    attachments: Option<Value>,
}

impl Raw {
    pub(super) fn of(payload: &Value) -> Self {
        let text = payload["text"].as_str().unwrap_or("").to_owned();
        let attachments = payload["attachments"]
            .as_array()
            .map(|refs| Value::Array(refs.iter().filter_map(project).collect()))
            .filter(|value| value.as_array().is_some_and(|list| !list.is_empty()));
        Self { text, attachments }
    }
}

/// Node `projectInputHistoryAttachments`: the submitted source, not the
/// resolved `AttachmentRef`. A local source keeps its path; a stored artifact
/// keeps only its reference as `content` (metadata is never invented).
fn project(item: &Value) -> Option<Value> {
    // 只用 trim 判空：合法路径末尾的空格是来源字节的一部分，不能在这里改写。
    let reference = item["ref"].as_str()?;
    if reference.trim().is_empty() {
        return None;
    }
    let mime = item["mime"].as_str().unwrap_or("").to_ascii_lowercase();
    let kind = if mime.starts_with("image/") {
        "image"
    } else if mime == "application/pdf" {
        "pdf"
    } else {
        "file"
    };
    let mut out = json!({ "type": kind });
    if reference.starts_with("zcode-artifact://") {
        out["content"] = reference.into();
    } else {
        out["path"] = reference.into();
    }
    Some(out)
}

impl Engine {
    /// Records an accepted root prompt: idle `prompt`, busy `steered_input`.
    /// Replays, promotions, reruns and child sessions never call this.
    pub(super) fn record_input_history(&mut self, id: &str, payload: &Value, kind: &str, raw: Raw) {
        // 编辑/重试旧轮的重放不是新历史；子代理输入也不属于根会话历史。
        let root = self.sessions.get(id).is_some_and(|s| s.parent_id.is_none());
        if !root || payload["_historyRerun"] == true {
            return;
        }
        let entry = InputHistory {
            id: self.clock.id(),
            project: self.workspace.clone(),
            session: Some(id.to_owned()),
            text: raw.text,
            attachments: raw.attachments,
            kind: kind.into(),
        };
        self.node(id, move |s, now| s.node_input_history(now, entry));
    }

    /// `internal/inputHistory/recall`: one entry of this workspace identity's
    /// history (`{skip}`), or `null` past the end. The scope is the engine's
    /// full identity key; a remote identity is never parsed into a path.
    pub(super) async fn input_history_recall(&self, p: &Value) -> Result<Value> {
        let skip = match p.get("skip") {
            None | Some(Value::Null) => 0,
            Some(value) => value
                .as_u64()
                .and_then(|skip| u32::try_from(skip).ok())
                .with_context(|| RuntimeError::invalid_params("skip"))?,
        };
        let entry = self
            .store
            .recall_input_history(&self.workspace, skip)
            .await?;
        Ok(entry.unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_keep_their_submitted_source_before_preparation() {
        let payload = json!({"text": "  look  ", "attachments": [
            {"ref": "docs/a.md", "fileName": "a.md", "mime": "text/markdown", "bytes": 3},
            {"ref": "zcode-artifact://sess_1/up/pdf", "fileName": "b.pdf",
             "mime": "application/pdf", "bytes": 8},
            {"ref": "shot.png", "fileName": "shot.png", "mime": "image/png", "bytes": 8},
            {"ref": " ", "fileName": "x", "mime": "text/plain", "bytes": 1},
            {"ref": "notes .md ", "fileName": "notes .md", "mime": "text/markdown", "bytes": 2},
        ]});
        let raw = Raw::of(&payload);
        // 用户原文原样保存（trim 由仓储规则处理），不以 AttachmentRef 落库。
        assert_eq!(raw.text, "  look  ");
        assert_eq!(
            raw.attachments,
            Some(json!([
                {"type":"file","path":"docs/a.md"},
                {"type":"pdf","content":"zcode-artifact://sess_1/up/pdf"},
                {"type":"image","path":"shot.png"},
                // 合法路径的尾空格是来源字节的一部分：只用 trim 判空，不改写。
                {"type":"file","path":"notes .md "},
            ]))
        );
        assert_eq!(Raw::of(&json!({"text":"x"})).attachments, None);
    }
}
