// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! 项目记忆索引（上游 3.18.2 F1 auto-memory）：`<cli>/memories/projects/<slug>-<hash>/memory/MEMORY.md`。
//! 路径与 `core/src/memory/project-root.ts` 同构；格式化与 `core/src/memory/index-content.ts`
//! 的行数/字符上限一致。顶层 HTML 注释剥离需要 Markdown lexer，本仓不新增依赖，登记为差距。
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const MEMORY_INDEX_FILE_NAME: &str = "MEMORY.md";
const LINE_LIMIT: usize = 200;
const CHARACTER_LIMIT: usize = 25_000;
const OMITTED_PREVIEW_MAX: usize = 80;

/// 上游 `resolveProjectMemoryRoot`：显式 workspaceIdentity 优先，否则规范化工作区路径。
pub fn project_memory_root(
    cli_root: &Path,
    workspace_identity: Option<&str>,
    workspace_path: &Path,
) -> PathBuf {
    let identity = workspace_identity.map(str::trim).filter(|v| !v.is_empty());
    let normalized = workspace_path.to_string_lossy().into_owned();
    let key_source = identity.map_or_else(
        || {
            if cfg!(windows) {
                normalized.to_lowercase()
            } else {
                normalized
            }
        },
        str::to_owned,
    );
    let hash = format!("{:x}", Sha256::digest(key_source.as_bytes()));
    let hash = &hash[..16];
    let slug = match identity {
        Some(_) => "project".to_owned(),
        None => sanitize_slug(
            workspace_path
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
                .as_str(),
        ),
    };
    cli_root
        .join("memories")
        .join("projects")
        .join(format!("{slug}-{hash}"))
        .join("memory")
}

fn sanitize_slug(value: &str) -> String {
    let slug: String = value
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    let truncated: String = slug.chars().take(48).collect();
    if truncated.is_empty() {
        "project".into()
    } else {
        truncated
    }
}

/// 上游 `formatProjectMemoryIndexContent` 的确定性部分：去掉前导 frontmatter，
/// 超过 200 行或 25,000 字符时截断并附警告；空索引返回空串（不公告）。
pub fn format_index(content: &str) -> String {
    let content = strip_frontmatter(content);
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let line_count = lines.len();
    let character_count = trimmed.encode_utf16().count();
    let line_truncated = line_count > LINE_LIMIT;
    let character_truncated = character_count > CHARACTER_LIMIT;
    if !line_truncated && !character_truncated {
        return trimmed.to_owned();
    }
    let mut truncated = if line_truncated {
        lines[..LINE_LIMIT].join("\n")
    } else {
        trimmed.to_owned()
    };
    if truncated.encode_utf16().count() > CHARACTER_LIMIT {
        truncated = truncate_utf16(&truncated, CHARACTER_LIMIT);
        // 上游优先在最后一个换行处切；没有换行时保留字符上限。
        if let Some(newline) = truncated.rfind('\n') {
            truncated.truncate(newline);
        }
    }
    let size = if character_truncated && !line_truncated {
        format!(
            "{} (limit: {}) — index entries are too long",
            bytes(character_count),
            bytes(CHARACTER_LIMIT)
        )
    } else if line_truncated && !character_truncated {
        format!("{line_count} lines (limit: {LINE_LIMIT})")
    } else {
        format!("{line_count} lines and {}", bytes(character_count))
    };
    let retained_lines = if trimmed[truncated.len()..].starts_with('\n') {
        truncated.split('\n').count()
    } else {
        0
    };
    let omitted = trimmed[truncated.len()..].trim_start_matches('\n');
    let omitted_line = omitted.split('\n').next().unwrap_or("").trim();
    let preview = preview_line(omitted_line);
    let omitted_description = if retained_lines == 0 {
        format!(
            "everything after the first {} characters of line 1 was cut off",
            truncated.encode_utf16().count()
        )
    } else {
        format!(
            "{} of {line_count} lines were cut off, starting at line {}{}",
            line_count - retained_lines,
            retained_lines + 1,
            if preview.is_empty() {
                String::new()
            } else {
                format!(" (\"{preview}\")")
            }
        )
    };
    format!(
        "{truncated}\n\n> WARNING: MEMORY.md is {size}. Only part of it was loaded: {omitted_description}. Keep index entries to one line under ~200 chars; move detail into topic files."
    )
}

fn strip_frontmatter(content: &str) -> &str {
    let Some(rest) = content.strip_prefix("---") else {
        return content;
    };
    let Some(end) = rest.find("\n---") else {
        return content;
    };
    let after = &rest[end + 4..];
    // 上游允许 `---\s*\n...---\s*\n?`：结束标记后只跳过紧邻的空白。
    after.trim_start_matches(['\r', '\n'])
}

fn truncate_utf16(text: &str, limit: usize) -> String {
    let mut used = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if used + width > limit {
            break;
        }
        used += width;
        end = index + ch.len_utf8();
    }
    text[..end].to_owned()
}

fn preview_line(line: &str) -> String {
    if line.encode_utf16().count() <= OMITTED_PREVIEW_MAX {
        return line.to_owned();
    }
    let prefix = truncate_utf16(line, OMITTED_PREVIEW_MAX - 1);
    let words = prefix
        .find(|c: char| c.is_whitespace())
        .map_or("", |index| prefix[..index].trim_end());
    let chosen = if words.encode_utf16().count() > OMITTED_PREVIEW_MAX / 2 {
        words
    } else {
        prefix.trim_end()
    };
    format!("{chosen}…")
}

fn bytes(value: usize) -> String {
    let kilobytes = value as f64 / 1024.0;
    if kilobytes < 1.0 {
        format!("{value} bytes")
    } else if kilobytes < 1024.0 {
        format!("{}KB", trim_zero(kilobytes))
    } else {
        let megabytes = kilobytes / 1024.0;
        if megabytes < 1024.0 {
            format!("{}MB", trim_zero(megabytes))
        } else {
            format!("{}GB", trim_zero(megabytes / 1024.0))
        }
    }
}

fn trim_zero(value: f64) -> String {
    format!("{value:.1}").trim_end_matches(".0").to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_memory_root_matches_the_node_slug_and_hash_shape() {
        let root = project_memory_root(Path::new("/cli"), None, Path::new("/work/Site"));
        let rendered = root.to_string_lossy();
        assert!(rendered.contains("/memories/projects/site-"));
        assert!(rendered.ends_with("/memory"));
        // 显式 identity 使用 project 前缀，且 hash 只取前 16 位。
        let identity = project_memory_root(Path::new("/cli"), Some("remote-1"), Path::new("/work"));
        let key = format!("{:x}", Sha256::digest(b"remote-1"));
        assert_eq!(
            identity,
            PathBuf::from(format!(
                "/cli/memories/projects/project-{}/memory",
                &key[..16]
            ))
        );
    }

    #[test]
    fn an_empty_or_frontmatter_only_index_is_not_announced() {
        assert_eq!(format_index("\n  \n"), "");
        assert_eq!(format_index("---\ntitle: x\n---\n"), "");
        assert_eq!(
            format_index("---\ntitle: x\n---\n# Notes\nbody"),
            "# Notes\nbody"
        );
    }

    #[test]
    fn an_oversized_index_is_truncated_with_a_warning() {
        let long: String = (0..250)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let formatted = format_index(&long);
        assert!(formatted.contains("WARNING: MEMORY.md is 250 lines (limit: 200)"));
        assert!(formatted.contains("starting at line 201"));
        assert!(formatted.lines().count() > 200);
        let huge = "x".repeat(CHARACTER_LIMIT + 100);
        let formatted = format_index(&huge);
        assert!(formatted.contains("index entries are too long"));
    }
}
