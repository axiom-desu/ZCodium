// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! CLI 存储根下按会话/项目定位的数据文件（Node `session-data-files/index.ts`）。
//! 只统计真实删除的文件；lstat 不跟随符号链接；路径不存在按 0；删除返回删除前字节数。
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const SESSION_DIRECTORY_ROOTS: [&str; 4] = ["artifacts", "exec", "agents", "sessions"];
const MODEL_IO_DIRECTORIES: [&str; 2] = ["debug", "rollout"];
const ARTIFACT_DIRECTORY: &str = "artifacts";
const MEMORY_PROJECTS: [&str; 2] = ["memories", "projects"];

fn safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn session_paths(root: &Path, session_id: &str) -> Result<Vec<PathBuf>> {
    if !safe_session_id(session_id) {
        bail!("session-data.invalid-session-id");
    }
    let mut paths: Vec<PathBuf> = SESSION_DIRECTORY_ROOTS
        .iter()
        .map(|name| root.join(name).join(session_id))
        .collect();
    paths.extend(
        MODEL_IO_DIRECTORIES
            .iter()
            .map(|name| root.join(name).join(format!("model-io-{session_id}.jsonl"))),
    );
    Ok(paths)
}

fn measure_path(path: &Path) -> Result<u64> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if !metadata.is_dir() {
        return Ok(metadata.len());
    }
    let mut total = 0;
    for entry in std::fs::read_dir(path)? {
        total += measure_path(&entry?.path())?;
    }
    Ok(total)
}

fn remove_all(paths: &[PathBuf]) -> Result<u64> {
    let bytes = paths.iter().try_fold(0u64, |sum, path| {
        Ok::<u64, anyhow::Error>(sum + measure_path(path)?)
    })?;
    for path in paths {
        match std::fs::remove_dir_all(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
                std::fs::remove_file(path)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(bytes)
}

fn kind_of(root: &Path, session_id: &str, path: &Path) -> &'static str {
    if path == root.join(ARTIFACT_DIRECTORY).join(session_id) {
        "artifact"
    } else {
        "record"
    }
}

fn walk(root: &Path, path: &Path, kind: &str, out: &mut Vec<Value>) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned();
    if metadata.file_type().is_symlink() {
        // 链接只记录自身，不沿链接清理用户文件。
        out.push(json!({"name": name, "relativePath": relative, "kind": kind, "bytes": 0}));
        return Ok(());
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            walk(root, &entry?.path(), kind, out)?;
        }
        return Ok(());
    }
    out.push(json!({
        "name": name,
        "relativePath": relative,
        "kind": kind,
        "bytes": metadata.len(),
    }));
    Ok(())
}

pub fn list(root: &Path, session_id: &str) -> Result<Vec<Value>> {
    let mut files = Vec::new();
    for path in session_paths(root, session_id)? {
        // 存储类别目录若被换成链接，不能沿祖先链接清理用户文件。
        if let Some(parent) = path.parent()
            && let Ok(metadata) = std::fs::symlink_metadata(parent)
            && metadata.file_type().is_symlink()
        {
            bail!("session-data.symlink-root");
        }
        let kind = kind_of(root, session_id, &path);
        walk(root, &path, kind, &mut files)?;
    }
    files.sort_by(|a, b| a["relativePath"].as_str().cmp(&b["relativePath"].as_str()));
    Ok(files)
}

pub fn measure(root: &Path, session_id: &str) -> Result<u64> {
    session_paths(root, session_id)?
        .iter()
        .try_fold(0u64, |sum, path| Ok(sum + measure_path(path)?))
}

/// 保留仍被外部引用的附件文件；其余会话文件（正文、执行日志、独占附件）全部删除。
pub fn remove(root: &Path, session_id: &str, retained: &[String]) -> Result<u64> {
    let paths = session_paths(root, session_id)?;
    let manifest = list(root, session_id)?;
    let total = manifest
        .iter()
        .map(|file| file["bytes"].as_u64().unwrap_or(0))
        .sum();
    if retained.is_empty() {
        remove_all(&paths)?;
        return Ok(total);
    }
    let keep = |file: &Value| {
        file["kind"].as_str() == Some("artifact")
            && retained
                .iter()
                .any(|id| file["name"].as_str().is_some_and(|name| name.contains(id)))
    };
    let mut removed = 0;
    for file in &manifest {
        if keep(file) {
            continue;
        }
        let relative = file["relativePath"].as_str().unwrap_or_default();
        std::fs::remove_file(root.join(relative))?;
        removed += file["bytes"].as_u64().unwrap_or(0);
    }
    // 保留附件目录，其它类别目录整体删除。
    for path in paths.iter().skip(1) {
        match std::fs::remove_dir_all(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
                std::fs::remove_file(path)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(removed)
}

/// Node `resolveProjectMemoryRoot`：`<cliStorageRoot>/memories/projects/<slug>-<hash>`。
/// hash 是 identity（或规范化路径）sha256 前 16 位；Windows 路径按小写。
pub fn memory_root(root: &Path, workspace_path: &str, identity: Option<&str>) -> Result<PathBuf> {
    let identity = identity.map(str::trim).filter(|value| !value.is_empty());
    let normalized = normalize_path(workspace_path)?;
    let key_source = identity.map_or_else(
        || {
            if cfg!(windows) {
                normalized.to_lowercase()
            } else {
                normalized.clone()
            }
        },
        str::to_owned,
    );
    let hash = format!("{:x}", Sha256::digest(key_source.as_bytes()));
    let slug = match identity {
        Some(_) => "project".to_owned(),
        None => sanitize_slug(
            &Path::new(&normalized)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
        ),
    };
    Ok(root
        .join(MEMORY_PROJECTS[0])
        .join(MEMORY_PROJECTS[1])
        .join(format!("{slug}-{}", &hash[..16])))
}

/// JS `path.resolve` 的实用等价：相对路径按当前目录展开，`.`/`..` 归一。
fn normalize_path(path: &str) -> Result<String> {
    let joined = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        std::env::current_dir()
            .context("Working directory unavailable")?
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out.to_string_lossy().into_owned())
}

fn sanitize_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
            dash = false;
        } else if !dash {
            slug.push('-');
            dash = true;
        }
    }
    let slug = slug.trim_matches('-').chars().take(48).collect::<String>();
    if slug.is_empty() {
        "project".into()
    } else {
        slug
    }
}

pub fn measure_memory(root: &Path, workspace_path: &str, identity: Option<&str>) -> Result<u64> {
    measure_path(&memory_root(root, workspace_path, identity)?.join("memory"))
}

pub fn remove_memory(root: &Path, workspace_path: &str, identity: Option<&str>) -> Result<u64> {
    let project = memory_root(root, workspace_path, identity)?;
    let bytes = measure_path(&project.join("memory"))?;
    match std::fs::remove_dir_all(&project) {
        Ok(()) => Ok(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}
