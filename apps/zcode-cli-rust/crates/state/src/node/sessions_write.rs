//! Durable `session` row writes split out of `sessions.rs` (400-line boundary):
//! Node `updateSession` (partial columns) and `softDeleteSession`.
use super::json::encode;
use super::sessions::{Patch, SessionRow, Update, must_get};
use rusqlite::{Connection, params, types::Value as Sql};
use serde_json::Value;

/// Node `updateSession`: partial columns only (undefined keeps the stored value).
///
/// 修复根因：整行读改写会用旧快照覆盖并发标题/权限/`last_outcome`（终态结果与标题
/// sidecar 会并发写同一行）。这里只写本次输入拥有的列；标题 CAS 由 SQL 守卫。
pub fn update(conn: &Connection, input: &Update, now: i64) -> anyhow::Result<SessionRow> {
    let mut fields: Vec<String> = vec![];
    let mut values: Vec<Sql> = vec![];
    let text = |v: &String| Sql::Text(v.clone());
    let integer = |v: &i64| Sql::Integer(*v);
    set(
        &mut fields,
        &mut values,
        "directory",
        input.directory.as_ref().map(text),
    );
    set(&mut fields, &mut values, "path", patch(&input.path, text));
    set(
        &mut fields,
        &mut values,
        "title",
        input.title.as_ref().map(text),
    );
    set(
        &mut fields,
        &mut values,
        "title_source",
        input.title_source.as_ref().map(text),
    );
    set(
        &mut fields,
        &mut values,
        "title_message_id",
        patch(&input.title_message_id, text),
    );
    set(
        &mut fields,
        &mut values,
        "share_url",
        patch(&input.share_url, text),
    );
    set(
        &mut fields,
        &mut values,
        "last_outcome",
        input.last_outcome.as_ref().map(text),
    );
    // `summary: null` 清空四列，`undefined` 保持；与 Node 的 `input.summary === undefined` 分支同语义。
    let summary = match &input.summary {
        Patch::Keep => None,
        Patch::Clear => Some(None),
        Patch::Set(s) => Some(Some(s)),
    };
    if let Some(summary) = summary {
        let column = |v: Option<i64>| Some(v.map_or(Sql::Null, Sql::Integer));
        set(
            &mut fields,
            &mut values,
            "summary_additions",
            column(summary.and_then(|s| s.additions)),
        );
        set(
            &mut fields,
            &mut values,
            "summary_deletions",
            column(summary.and_then(|s| s.deletions)),
        );
        set(
            &mut fields,
            &mut values,
            "summary_files",
            column(summary.and_then(|s| s.files)),
        );
        set(
            &mut fields,
            &mut values,
            "summary_diffs",
            patch_json(&Patch::from(summary.and_then(|s| s.diffs.clone()))),
        );
    }
    set(
        &mut fields,
        &mut values,
        "revert",
        patch_json(&input.revert),
    );
    set(
        &mut fields,
        &mut values,
        "permission",
        patch_json(&input.permission),
    );
    set(
        &mut fields,
        &mut values,
        "time_compacting",
        patch(&input.time_compacting, integer),
    );
    if input.title.is_some() || input.title_source.is_some() || input.title_message_id.given() {
        set(
            &mut fields,
            &mut values,
            "time_title_updated",
            Some(Sql::Integer(now)),
        );
    }
    // 标题与组织态不代表会话活动；活动时间只由明确提交的 `timeUpdated` 推进，且禁止回退。
    if let Some(updated) = input.time_updated {
        fields.push("time_updated = max(time_updated, ?)".into());
        values.push(Sql::Integer(updated));
    }
    if fields.is_empty() {
        return must_get(conn, &input.id);
    }
    let mut sql = format!("update session set {} where id = ?", fields.join(","));
    values.push(Sql::Text(input.id.clone()));
    let sources = input
        .title
        .as_ref()
        .map(|_| &input.expected_title_sources)
        .filter(|s| !s.is_empty());
    if let Some(sources) = sources {
        let slots = vec!["?"; sources.len()].join(",");
        sql.push_str(&format!(
            " and coalesce(title_source, 'first_input') in ({slots})"
        ));
        values.extend(sources.iter().map(|s| Sql::Text(s.clone())));
    }
    conn.prepare_cached(&sql)?
        .execute(rusqlite::params_from_iter(values))?;
    must_get(conn, &input.id)
}

fn set(fields: &mut Vec<String>, values: &mut Vec<Sql>, column: &str, value: Option<Sql>) {
    if let Some(value) = value {
        fields.push(format!("{column} = ?"));
        values.push(value);
    }
}

/// A nullable column in an update: keep, clear (`null`) or set.
fn patch<T>(value: &Patch<T>, map: impl FnOnce(&T) -> Sql) -> Option<Sql> {
    match value {
        Patch::Keep => None,
        Patch::Clear => Some(Sql::Null),
        Patch::Set(value) => Some(map(value)),
    }
}

fn patch_json(value: &Patch<Value>) -> Option<Sql> {
    patch(value, |v| encode(v).map_or(Sql::Null, Sql::Text))
}

impl From<Option<Value>> for Patch<Value> {
    fn from(value: Option<Value>) -> Self {
        value.map_or(Self::Clear, Self::Set)
    }
}

/// Node `softDeleteSession`: `coalesce` keeps the first deletion time, so repeats are idempotent.
/// Body rows (`message`/`part`/`session_entry`) and `time_updated` stay untouched.
pub fn soft_delete(conn: &Connection, id: &str, at: i64) -> rusqlite::Result<usize> {
    conn.prepare_cached("update session set time_deleted = coalesce(time_deleted, ?) where id = ?")?
        .execute(params![at, id])
}

/// Node list visibility: a soft-deleted row is never returned by ordinary lists.
pub fn visible(row: &SessionRow) -> bool {
    row.time_deleted.is_none()
}
