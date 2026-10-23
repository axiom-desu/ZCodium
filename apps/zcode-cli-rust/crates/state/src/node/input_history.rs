//! `input_history` rows (Node `repositories/input-history.ts`): deduplicated
//! against the project's latest entry and capped at 100 rows over the whole
//! table. The caller owns the transaction. Spec rust-m11-node-storage §4.
use super::json::stringify;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

const LIMIT: i64 = 100;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub text: String,
    pub attachments: Option<Value>,
    pub kind: String,
    pub time_created: i64,
}

/// The history scope of a workspace: the full identity key
/// (`workspaceIdentity?.trim() || workspacePath`) stored as `project_id` text.
///
/// The root already canonicalized the key, so the store keeps it byte-for-byte:
/// trimming again would merge `/repo` with the valid local path `/repo `.
/// The column has no project FK, and a path or slug would merge different
/// remote identities of the same path (spec cli-rust-tui-workbench §1).
pub fn scope(workspace: &str) -> String {
    workspace.to_owned()
}

/// One entry as the recall port's `InputHistoryEntry` JSON.
pub fn value(entry: &Entry) -> Value {
    let mut out = json!({
        "id": entry.id,
        "text": entry.text,
        "kind": entry.kind,
        "timeCreated": entry.time_created,
    });
    if let Some(session) = &entry.session_id {
        out["sessionId"] = session.as_str().into();
    }
    if let Some(attachments) = &entry.attachments {
        out["attachments"] = attachments.clone();
    }
    out
}

/// Node `normalizedInputHistoryAttachments` 的字段规则，沿用仓储既有归一化并与
/// TS 行逐字节一致；来源字节在写入前的 `core::app::input_history::project` 投影
/// 里保留（那里只用 trim 判空），这一层按 Node 规则归一化。
fn trimmed(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|s| s.trim_matches(super::migrations::js_whitespace))
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Node `normalizedInputHistoryAttachments`.
fn normalize(attachments: Option<&Value>) -> Option<Value> {
    let normalized: Vec<Value> = attachments
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let kind = a["type"]
                .as_str()
                .filter(|t| matches!(*t, "file" | "image" | "pdf" | "url"))?;
            let path = trimmed(&a["path"]);
            let content = trimmed(&a["content"]).filter(|c| !c.starts_with("data:"));
            if path.is_none() && content.is_none() {
                return None;
            }
            let mut out = json!({"type": kind});
            if let Some(path) = path {
                out["path"] = path.into();
            }
            if let Some(content) = content {
                out["content"] = content.into();
            }
            Some(out)
        })
        .collect();
    (!normalized.is_empty()).then_some(Value::Array(normalized))
}

fn stable(attachments: Option<&Value>) -> String {
    stringify(&normalize(attachments).unwrap_or_else(|| json!([])))
}

/// Node `recordInputHistory`; `None` for blank text or a repeat of the latest entry.
#[allow(clippy::too_many_arguments)]
pub fn record(
    conn: &Connection,
    id: &str,
    project: &str,
    session: Option<&str>,
    text: &str,
    attachments: Option<&Value>,
    kind: &str,
    created: i64,
) -> Result<Option<Entry>> {
    let text = text.trim_matches(super::migrations::js_whitespace);
    if text.is_empty() {
        return Ok(None);
    }
    let attachments = normalize(attachments);
    if let Some(latest) = recall(conn, project, 0)?
        && latest.text == text
        && stable(latest.attachments.as_ref()) == stable(attachments.as_ref())
    {
        return Ok(None);
    }
    conn.prepare_cached(
        "insert into input_history (id, project_id, session_id, text, attachments, kind, time_created)
        values (?, ?, ?, ?, ?, ?, ?)",
    )?
    .execute(params![
        id,
        project,
        session,
        text,
        attachments.as_ref().map(stringify),
        kind,
        created
    ])?;
    conn.prepare_cached(
        "delete from input_history where id not in (
          select id from input_history order by time_created desc, id desc limit ?
        )",
    )?
    .execute([LIMIT])?;
    Ok(Some(Entry {
        id: id.into(),
        project_id: project.into(),
        session_id: session.map(str::to_owned),
        text: text.into(),
        attachments,
        kind: kind.into(),
        time_created: created,
    }))
}

/// Node `recallPreviousInputHistory`.
pub fn recall(conn: &Connection, project: &str, skip: i64) -> Result<Option<Entry>> {
    let decode = |r: &rusqlite::Row| -> rusqlite::Result<Entry> {
        let attachments: Option<String> = r.get(3)?;
        Ok(Entry {
            id: r.get(0)?,
            project_id: project.into(),
            session_id: r.get::<_, Option<String>>(1)?.filter(|s| !s.is_empty()),
            text: r.get(2)?,
            // 存储值在读取后再按 Node 规则归一化；解析失败在下方报错。
            attachments: attachments.map(Value::String),
            kind: r.get(4)?,
            time_created: r.get(5)?,
        })
    };
    let entry = conn
        .prepare_cached(
            "select id, session_id, text, attachments, kind, time_created from input_history
      where project_id = ? order by time_created desc, id desc limit 1 offset ?",
        )?
        .query_row(params![project, skip], decode)
        .optional()?;
    let Some(mut entry) = entry else {
        return Ok(None);
    };
    let stored = match entry.attachments.take() {
        Some(Value::String(text)) => Some(serde_json::from_str::<Value>(&text)?),
        _ => None,
    };
    entry.attachments = normalize(stored.as_ref());
    Ok(Some(entry))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_keeps_the_root_canonical_key_byte_for_byte() {
        // root 已按 `identity.trim() || workspacePath` 规范化；这里不再二次 trim，
        // 否则 `/repo` 与合法的 `/repo ` 会共用同一 scope。
        assert_eq!(scope("/repo "), "/repo ");
        assert_eq!(scope("/repo"), "/repo");
        assert_ne!(scope("/repo"), scope("/repo "));
        assert_eq!(scope(" remote-1 "), " remote-1 ");
    }

    #[test]
    fn attachment_normalization_follows_the_node_repository_rule() {
        // 仓储沿用 Node 归一化（与 TS 行逐字节一致），来源字节在 core 投影处保留。
        let normalized = normalize(Some(&serde_json::json!([
            {"type": "file", "path": " /a "},
            {"type": "file", "path": "  "},
            {"type": "file", "content": "data:image/png;base64,AAAA"},
        ])))
        .unwrap();
        assert_eq!(
            normalized,
            serde_json::json!([{"type": "file", "path": "/a"}])
        );
    }
}
