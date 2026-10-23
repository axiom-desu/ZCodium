//! `@file` 的 workspace 路径查询。
//!
//! token 解析与 TS `tui-workspace-paths.ts` 一致：拒绝绝对路径、盘符与任意 `..` 段；
//! 目录列举在独立 task 内完成，只读目录项元数据、不读文件内容，并以 canonical 边界
//! 阻止 symlink 穿出 workspace。错误显式返回，不把失败伪装成“无匹配”。
use anyhow::{Context, Result, ensure};
use std::{cmp::Ordering, path::Path};

/// 候选上限（spec：最多 50 结果）。
pub(crate) const DEFAULT_LIMIT: usize = 50;
/// 流式扫描时每处理这么多目录项让出一次，任务可被取消，但不会人为截断扫描范围。
const YIELD_EVERY: usize = 256;
/// 版本控制与依赖目录一律不进候选。
const EXCLUDED_DIRECTORIES: [&str; 7] =
    [".bzr", ".git", ".hg", ".jj", ".sl", ".svn", "node_modules"];

/// 一个可插入草稿的 workspace 路径；`path` 是 workspace 相对路径，目录以 `/` 结尾。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) directory: bool,
    pub(crate) mime: String,
    /// 真实文件字节数（`metadata().len()`）；目录为 0。
    pub(crate) bytes: u64,
}

/// `@token` 拆分出的目录前缀与查询词。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Parsed {
    pub(crate) directory: String,
    pub(crate) query: String,
}

/// 解析 `@` 之后的 token；`None` 表示不可安全解析（绝对/盘符/`..`/控制符/空白）。
pub(crate) fn parse(token: &str) -> Option<Parsed> {
    let trimmed = token.strip_prefix('@').unwrap_or(token);
    if trimmed.is_empty() {
        return Some(Parsed {
            directory: String::new(),
            query: String::new(),
        });
    }
    // 控制符与空白都不能出现在 `@token` 里（编辑器也不会产生），明确不支持而不是猜。
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') || is_drive(trimmed) {
        return None;
    }
    let normalized = trimmed.replace('\\', "/");
    if is_drive(&normalized) || normalized.split('/').any(|part| part == "..") {
        return None;
    }
    let (directory, query) = match normalized.rfind('/') {
        Some(index) => (
            normalized[..=index].to_owned(),
            normalized[index + 1..].to_owned(),
        ),
        None => (String::new(), normalized),
    };
    Some(Parsed { directory, query })
}

fn is_drive(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// 由文件名推断 MIME；未知后缀用二进制，避免编造能力。
pub(crate) fn mime_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "c" | "h"
        | "cpp" | "hpp" | "sh" | "toml" | "yaml" | "yml" | "css" | "scss" | "sql" => "text/plain",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// 在 `directory` 下按 token 列举候选；返回 `(最佳候选, 匹配总数是否超过 limit)`。
///
/// 扫描是流式的：遍历整个目录，但只在内存里维护按排序规则最好的 `limit` 项，
/// 因此超大目录既不会漏掉后面的精确文件，也不会把一次按键变成无界内存。
pub(crate) async fn query(
    directory: &str,
    token: &str,
    limit: usize,
) -> Result<(Vec<Entry>, bool)> {
    let parsed = parse(token).context("Unsupported workspace path")?;
    let limit = limit.max(1);
    // canonical root 是边界唯一真相；后续所有路径都回到它下面比较。
    let root = tokio::fs::canonicalize(directory)
        .await
        .with_context(|| format!("Workspace directory is unavailable: {directory}"))?;
    let prefix = parsed.directory.trim_end_matches('/');
    // TS 只在列举目录的条目名上排除 VCS/依赖目录；`@node_modules/x` 这类前缀 token
    // 会绕过它，所以在解析阶段就明确拒绝，避免把排除目录重新建议出来。
    ensure!(
        !excluded_prefix(prefix),
        "Excluded workspace directory: {prefix}"
    );
    let target = if prefix.is_empty() {
        root.clone()
    } else {
        root.join(prefix)
    };
    let target = tokio::fs::canonicalize(&target)
        .await
        .with_context(|| format!("Workspace directory is unavailable: {}", target.display()))?;
    ensure!(
        target == root || target.starts_with(&root),
        "Workspace path escapes the workspace"
    );

    let mut reader = tokio::fs::read_dir(&target)
        .await
        .with_context(|| format!("Cannot read directory: {}", target.display()))?;
    let query_lower = parsed.query.to_lowercase();
    let show_dotfiles = parsed.query.starts_with('.');
    let mut best: Vec<Entry> = Vec::with_capacity(limit);
    let mut matched = 0usize;
    let mut scanned = 0usize;
    while let Some(item) = reader.next_entry().await? {
        scanned += 1;
        if scanned.is_multiple_of(YIELD_EVERY) {
            // 只让出执行权以便取消，不改变扫描范围。
            tokio::task::yield_now().await;
        }
        // 非 UTF-8/含控制符/含空白的名称无法被 `@token` 精确引用，直接不展示。
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.is_empty() || name.chars().any(|c| c.is_control() || c.is_whitespace()) {
            continue;
        }
        if !show_dotfiles && name.starts_with('.') {
            continue;
        }
        if !query_lower.is_empty() && !name.to_lowercase().contains(&query_lower) {
            continue;
        }
        // 只有通过名称过滤的项才付出类型/元数据查询的代价。
        let file_type = item.file_type().await?;
        let located = if file_type.is_symlink() {
            // symlink 先解析再看边界：指向 workspace 外的链接不给候选。
            match tokio::fs::canonicalize(item.path()).await {
                Ok(path) if path == root || path.starts_with(&root) => path,
                _ => continue,
            }
        } else {
            item.path()
        };
        let (is_directory, bytes) = if file_type.is_symlink() {
            // symlink 的类型取决于目标，必须看目标 metadata。
            let metadata = tokio::fs::metadata(&located).await?;
            (metadata.is_dir(), metadata.len())
        } else if file_type.is_dir() {
            (true, 0)
        } else {
            // 真实字节数只用于 AttachmentRef 元数据，不读取文件内容。
            (false, tokio::fs::metadata(&located).await?.len())
        };
        if is_directory && excluded_name(&name) {
            continue;
        }
        let bytes = if is_directory { 0 } else { bytes };
        let Ok(relative) = located.strip_prefix(&root) else {
            continue;
        };
        let mut path = relative.to_string_lossy().replace('\\', "/");
        if is_directory {
            path.push('/');
        }
        matched += 1;
        keep_best(
            &mut best,
            Entry {
                path,
                directory: is_directory,
                mime: mime_for(&name).to_owned(),
                name,
                bytes,
            },
            limit,
            &query_lower,
        );
    }
    Ok((best, matched > limit))
}

/// 维护按排序规则最好的 `limit` 项；超出的候选直接丢弃，内存有界。
fn keep_best(best: &mut Vec<Entry>, entry: Entry, limit: usize, query_lower: &str) {
    let position = best
        .partition_point(|existing| compare(existing, &entry, query_lower) != Ordering::Greater);
    if position >= limit {
        return;
    }
    best.insert(position, entry);
    best.truncate(limit);
}

/// 目录名在任何 token 层级都属于排除集合（大小写不敏感，覆盖大小写不敏感文件系统）。
fn excluded_name(name: &str) -> bool {
    EXCLUDED_DIRECTORIES
        .iter()
        .any(|dir| name.eq_ignore_ascii_case(dir))
}

fn excluded_prefix(prefix: &str) -> bool {
    prefix
        .split('/')
        .any(|part| !part.is_empty() && excluded_name(part))
}

/// 目录优先、前缀优先，再按路径确定性排序。
fn compare(left: &Entry, right: &Entry, query_lower: &str) -> Ordering {
    right
        .directory
        .cmp(&left.directory)
        .then_with(|| {
            let left_prefix = left.name.to_lowercase().starts_with(query_lower);
            let right_prefix = right.name.to_lowercase().starts_with(query_lower);
            right_prefix.cmp(&left_prefix)
        })
        .then_with(|| left.path.cmp(&right.path))
}

/// 文件名校验：空/控制符名称不可作为附件名。
pub(crate) fn safe_file_name(path: &str) -> Option<String> {
    let name = Path::new(path).file_name()?.to_str()?.to_owned();
    if name.is_empty() || name.chars().count() > 255 || name.contains(['\0', '\r', '\n']) {
        return None;
    }
    if name.chars().any(char::is_control) {
        return None;
    }
    Some(name)
}

/// 显式的 MIME 校验，边界与 core 的 `valid_mime` 同形（`type/subtype`）。
pub(crate) fn valid_mime(mime: &str) -> bool {
    let Some((kind, subtype)) = mime.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && kind
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        && subtype
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
}

/// 拒绝空/控制符 ref。
pub(crate) fn valid_ref(reference: &str) -> bool {
    !reference.is_empty() && !reference.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "workspace_paths_tests.rs"]
mod workspace_paths_tests;
