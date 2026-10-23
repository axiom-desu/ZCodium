//! 草稿附件的唯一 owner。
//!
//! 只保存未提交草稿的来源投影；提交时输出严格 `AttachmentRef` 四字段，实际字节/MIME
//! 由 core 重新读取核实。inline `@path` 占位符被删除则对应附件不发送；启动 `--attach`
//! 是无占位符的 pinned 项，只在第一份草稿被接受后由前端 `clear`。
use crate::workspace_paths::{self, Entry};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

/// core 侧同一上限：`attachments.len() <= 16`。
pub(crate) const MAX_ATTACHMENTS: usize = 16;
/// `AttachmentRef` 的严格 wire 字段（`deny_unknown_fields`），顺序无语义。
const WIRE_FIELDS: [&str; 5] = ["ref", "fileName", "mime", "bytes", "previewRef"];

/// 草稿附件来源：只有 `Startup` 能在历史往返时跨层带入新草稿。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttachmentSource {
    /// 启动 `--attach`：唯一 active owner，直到 accepted clear。
    Startup,
    /// 编辑器内联 `@path` 占位符。
    Mention,
    /// 历史恢复项（inline 或 pinned），不能当成启动附件。
    History,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DraftAttachment {
    pub(crate) id: u64,
    pub(crate) source: AttachmentSource,
    /// wire `ref`：workspace 相对路径或绝对路径，由 core 重新解析并核实字节。
    pub(crate) reference: String,
    pub(crate) file_name: String,
    pub(crate) mime: String,
    /// 本地候选来自真实 metadata；历史恢复未读文件时为 0，由 core 核实。
    pub(crate) bytes: u64,
    /// 草稿中的 `@path` 占位符；`None` 表示启动/历史恢复的 pinned 项。
    pub(crate) placeholder: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttachResult {
    Added,
    Duplicate,
    Full,
    /// 名称/MIME 不可安全提交（控制符、非法 MIME），由前端提示而不是静默丢项。
    Rejected,
}

/// 草稿附件集合；`Clone` 用于历史往返与 snapshot 恢复。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DraftAttachments {
    items: Vec<DraftAttachment>,
    next_id: u64,
    /// `from_startup` 因重复而只保留首份的项数：前端可据此提示，不静默改变 `--attach`。
    startup_duplicates: usize,
}

impl DraftAttachments {
    pub(crate) fn items(&self) -> &[DraftAttachment] {
        &self.items
    }
    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// `from_startup` 去重时丢弃的重复项数量（保留首份），0 表示没有重复。
    pub(crate) fn startup_duplicates(&self) -> usize {
        self.startup_duplicates
    }

    pub(crate) fn clear(&mut self) {
        self.items.clear();
        self.next_id = 0;
    }

    fn next_id(&mut self) -> u64 {
        self.next_id = self.next_id.saturating_add(1);
        self.next_id
    }

    fn push(&mut self, mut attachment: DraftAttachment) -> AttachResult {
        if self.items.iter().any(|item| {
            item.reference == attachment.reference && item.placeholder == attachment.placeholder
        }) {
            return AttachResult::Duplicate;
        }
        if self.items.len() >= MAX_ATTACHMENTS {
            return AttachResult::Full;
        }
        attachment.id = self.next_id();
        self.items.push(attachment);
        AttachResult::Added
    }

    /// 选中文件时登记草稿附件；`ref` 用 workspace 相对路径，bytes/MIME 来自真实 metadata。
    pub(crate) fn attach_entry(&mut self, entry: &Entry) -> AttachResult {
        let Some(name) = workspace_paths::safe_file_name(&entry.path) else {
            return AttachResult::Rejected;
        };
        if !workspace_paths::valid_ref(&entry.path) || !workspace_paths::valid_mime(&entry.mime) {
            return AttachResult::Rejected;
        }
        self.push(DraftAttachment {
            id: 0,
            source: AttachmentSource::Mention,
            reference: entry.path.clone(),
            file_name: name,
            mime: entry.mime.clone(),
            bytes: entry.bytes,
            placeholder: Some(format!("@{}", entry.path)),
        })
    }

    /// 启动 `--attach`：每一项都必须是严格 `AttachmentRef`，恢复成无占位符的 pinned 项。
    ///
    /// 非法项、缺字段、未知字段或超过 core 上限都返回 `Err`，不再 `continue` 静默丢项。
    /// 完全相同的 `ref` 只保留首份（含其 metadata），并通过 [`Self::startup_duplicates`]
    /// 让前端能看见去重结果。
    pub(crate) fn from_startup(values: Vec<Value>) -> Result<Self> {
        ensure!(
            values.len() <= MAX_ATTACHMENTS,
            "Too many startup attachments ({} > {MAX_ATTACHMENTS})",
            values.len()
        );
        let mut result = Self::default();
        for value in values {
            let reference = startup_wire(&value)?;
            match result.push(reference) {
                AttachResult::Added => {}
                AttachResult::Duplicate => result.startup_duplicates += 1,
                // 上面已按 core 上限检查过；保留显式错误而不是静默截断。
                AttachResult::Full => bail!("Too many startup attachments (max {MAX_ATTACHMENTS})"),
                AttachResult::Rejected => bail!("Startup attachment is not usable"),
            }
        }
        Ok(result)
    }

    /// 从历史来源投影恢复草稿附件。
    ///
    /// 支持本地 `file`/`image`/`pdf`：MIME 由文件名派生并与历史类型核对，`ref` 保留历史
    /// 路径原字节，`bytes` 记 0 由 core 核实。正文里有 `@展示路径` 就是 inline 占位符，
    /// 否则按 pinned 恢复。无法证明的 `artifact`/内联 `content` 明确返回 `Err`。
    pub(crate) fn from_history(attachments: &Value, directory: &str, text: &str) -> Result<Self> {
        let mut result = Self::default();
        if attachments.is_null() {
            return Ok(result);
        }
        let items = attachments
            .as_array()
            .context("History attachments are malformed; draft was kept")?;
        ensure!(
            items.len() <= MAX_ATTACHMENTS,
            "Too many history attachments ({} > {MAX_ATTACHMENTS})",
            items.len()
        );
        for item in items {
            let attachment = draft_attachment_history::history_item(item, directory, text)?;
            // 同一来源重复出现时保留首份；历史只是回放用户已接受过的草稿。
            result.push(attachment);
        }
        Ok(result)
    }

    /// 历史往返带入已保存草稿的启动 pinned 项：同一 `ref` 只留一份，超上限显式 `Err`。
    pub(crate) fn adopt(&mut self, item: &DraftAttachment) -> Result<()> {
        if self.items.iter().any(|own| own.reference == item.reference) {
            return Ok(());
        }
        ensure!(
            self.items.len() < MAX_ATTACHMENTS,
            "too many draft attachments"
        );
        let mut item = item.clone();
        item.id = self.next_id();
        self.items.push(item);
        Ok(())
    }

    /// 严格 `AttachmentRef{ref,fileName,mime,bytes}`；不含 previewRef/artifact 伪造字段。
    pub(crate) fn refs_for_text(&self, text: &str) -> Vec<Value> {
        self.items
            .iter()
            .filter(|item| item.active_in(text))
            .take(MAX_ATTACHMENTS)
            .map(DraftAttachment::wire)
            .collect()
    }

    /// 占位符被删掉的附件不再发送；pinned 项（无占位符）保留到显式 `clear`。
    pub(crate) fn retain_for_text(&mut self, text: &str) {
        self.items.retain(|item| item.active_in(text));
    }
}

/// 校验并转换一个启动 `--attach` 项（严格 wire 形态）。
fn startup_wire(value: &Value) -> Result<DraftAttachment> {
    let fields = value
        .as_object()
        .context("Startup attachment must be an object")?;
    for key in fields.keys() {
        ensure!(
            WIRE_FIELDS.contains(&key.as_str()),
            "Startup attachment has an unknown field: {key}"
        );
    }
    let reference = fields
        .get("ref")
        .and_then(Value::as_str)
        .context("Startup attachment ref is missing")?;
    ensure!(
        workspace_paths::valid_ref(reference),
        "Startup attachment ref is invalid"
    );
    let file_name = fields
        .get("fileName")
        .and_then(Value::as_str)
        .context("Startup attachment fileName is missing")?;
    ensure!(
        workspace_paths::valid_ref(file_name) && file_name.chars().count() <= 255,
        "Startup attachment fileName is invalid"
    );
    let mime = fields
        .get("mime")
        .and_then(Value::as_str)
        .context("Startup attachment mime is missing")?;
    ensure!(
        workspace_paths::valid_mime(mime),
        "Startup attachment mime is invalid"
    );
    let bytes = fields
        .get("bytes")
        .and_then(Value::as_u64)
        .context("Startup attachment bytes is missing")?;
    if let Some(preview) = fields.get("previewRef") {
        ensure!(
            preview.is_null() || preview.as_str().is_some_and(workspace_paths::valid_ref),
            "Startup attachment previewRef is invalid"
        );
    }
    Ok(DraftAttachment {
        id: 0,
        source: AttachmentSource::Startup,
        // 本地来源可以用真实相对/绝对路径；core 会重新读取并覆盖字节/MIME。
        reference: draft_attachment_history::normalize_reference(reference),
        file_name: file_name.to_owned(),
        mime: mime.to_ascii_lowercase(),
        bytes,
        placeholder: None,
    })
}

impl DraftAttachment {
    fn active_in(&self, text: &str) -> bool {
        match &self.placeholder {
            None => true,
            Some(placeholder) => mentions(text, placeholder),
        }
    }

    fn wire(&self) -> Value {
        json!({
            "ref": self.reference,
            "fileName": self.file_name,
            "mime": self.mime,
            "bytes": self.bytes,
        })
    }
}

/// 占位符匹配必须带边界：只按 `contains` 会把 `@a` 错配到 `@ab`，把没提到的文件发出去。
pub(crate) fn mentions(text: &str, placeholder: &str) -> bool {
    if placeholder.is_empty() {
        return false;
    }
    let mut from = 0usize;
    while let Some(index) = text[from..].find(placeholder) {
        let start = from + index;
        let end = start + placeholder.len();
        let before_ok = text[..start]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        let after_ok = text[end..].chars().next().is_none_or(char::is_whitespace);
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

#[path = "draft_attachment_history.rs"]
mod draft_attachment_history;
#[cfg(test)]
#[path = "draft_attachments_recovery_tests.rs"]
mod draft_attachments_recovery_tests;
#[cfg(test)]
#[path = "draft_attachments_tests.rs"]
mod draft_attachments_tests;
