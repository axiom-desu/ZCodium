//! 历史附件的本地 ref 解析：只解析本地 `file`/`image`/`pdf` 投影，不读文件内容。
//!
//! 唯一 owner 仍是 [`crate::draft_attachments::DraftAttachments::from_history`]；这里只把
//! 历史里的 `{type,path}` 校验、派生 MIME、匹配正文占位符，产出一份待入集合的附件。
use super::{AttachmentSource, DraftAttachment, mentions};
use crate::workspace_paths;
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::path::Path;

/// 校验并转换一个历史来源投影 `{type,path?,content?}`。
pub(super) fn history_item(item: &Value, directory: &str, text: &str) -> Result<DraftAttachment> {
    let fields = item
        .as_object()
        .context("History attachment must be an object")?;
    let kind = fields
        .get("type")
        .and_then(Value::as_str)
        .context("History attachment type is missing")?;
    ensure!(
        kind != "artifact",
        "History artifact attachment cannot be restored by the TUI"
    );
    ensure!(
        kind == "file" || kind == "image" || kind == "pdf",
        "Unsupported history attachment type: {kind}"
    );
    // 内联 content 是历史里记录的字节，TUI 不读内容也不能把它们编成 AttachmentRef。
    ensure!(
        fields.get("content").is_none_or(Value::is_null),
        "History {kind} attachment carries inline content the TUI cannot restore"
    );
    let path = fields
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .context("History attachment path is missing")?;
    ensure!(
        workspace_paths::valid_ref(path),
        "History attachment path is invalid"
    );
    let file_name =
        workspace_paths::safe_file_name(path).context("History attachment name is invalid")?;
    let mime = history_mime(kind, &file_name)?;
    let placeholder = match mention_display(path, directory) {
        Some(display) if mentions(text, &format!("@{display}")) => Some(format!("@{display}")),
        // 历史正文没有占位符（启动 `--attach`）或路径无法写成 token：pinned 恢复，不丢附件。
        _ => None,
    };
    Ok(DraftAttachment {
        id: 0,
        source: AttachmentSource::History,
        reference: normalize_reference(path),
        file_name,
        mime,
        bytes: 0,
        placeholder,
    })
}

/// 按文件名派生 MIME，并与历史记录的类型互相核对；不一致就不猜。
fn history_mime(kind: &str, file_name: &str) -> Result<String> {
    let mime = workspace_paths::mime_for(file_name).to_owned();
    match kind {
        "image" => ensure!(
            mime.starts_with("image/"),
            "History image attachment has no derivable image MIME"
        ),
        "pdf" => ensure!(
            mime == "application/pdf",
            "History pdf attachment has no derivable PDF MIME"
        ),
        _ => {}
    }
    ensure!(
        workspace_paths::valid_mime(&mime),
        "History attachment MIME is invalid"
    );
    Ok(mime)
}

/// 可安全写成 `@token` 的展示路径；`None` 表示只能 pinned 恢复（绝对/外部/含空白/`..`）。
/// 只做展示，不改变 wire ref，也不把 workspace 外的绝对路径扩成新的 `@` 建议。
fn mention_display(path: &str, directory: &str) -> Option<String> {
    let host = Path::new(path);
    let display = if host.is_absolute() {
        let relative = host.strip_prefix(Path::new(directory)).ok()?;
        relative.to_string_lossy().replace('\\', "/")
    } else {
        path.replace('\\', "/")
    };
    let display = display
        .strip_prefix("./")
        .map(str::to_owned)
        .unwrap_or(display);
    let safe = !display.is_empty()
        && !display.starts_with('/')
        && !display.starts_with("..")
        && !display.split('/').any(|part| part == "..")
        && !display.chars().any(|c| c.is_control() || c.is_whitespace());
    safe.then_some(display)
}

/// 相对路径去掉可省略的 `./` 前缀，`ref` 对 core 仍指向同一文件。
pub(super) fn normalize_reference(reference: &str) -> String {
    if Path::new(reference).is_absolute() {
        return reference.to_owned();
    }
    reference.strip_prefix("./").unwrap_or(reference).to_owned()
}
