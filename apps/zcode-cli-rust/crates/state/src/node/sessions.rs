//! `session` rows (Node `repositories/sessions.ts`). Spec rust-m11-node-storage §4.
use super::codecs::{TASK_TYPES, TITLE_SOURCES};
use super::json::encode;
use rusqlite::{Connection, OptionalExtension, Row, params, types::Value as Sql};
use serde_json::Value;

pub use super::sessions_write::{soft_delete, update, visible};

/// Node `SessionInfo` as stored.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionRow {
    pub id: String,
    pub project_id: String,
    pub workspace_id: Option<String>,
    pub parent_id: Option<String>,
    pub trace_id: Option<String>,
    pub task_type: String,
    pub slug: String,
    pub directory: String,
    pub path: Option<String>,
    pub title: String,
    pub title_source: String,
    pub title_message_id: Option<String>,
    pub version: String,
    pub share_url: Option<String>,
    pub summary: Summary,
    pub revert: Option<Value>,
    pub permission: Option<Value>,
    pub time_created: i64,
    pub time_updated: i64,
    pub time_title_updated: Option<i64>,
    pub time_compacting: Option<i64>,
    pub time_archived: Option<i64>,
    /// Node `time_deleted`: soft deletion; a deleted row never resurfaces.
    pub time_deleted: Option<i64>,
    /// Node `lastOutcome`: the previous turn's terminal result.
    pub last_outcome: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Summary {
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub files: Option<i64>,
    pub diffs: Option<Value>,
}

/// Node `CreateSessionInput`.
#[derive(Clone, Debug, Default)]
pub struct Create {
    pub id: String,
    pub project_id: String,
    pub workspace_id: Option<String>,
    pub parent_id: Option<String>,
    pub trace_id: Option<String>,
    pub task_type: Option<String>,
    pub slug: String,
    pub directory: String,
    pub path: Option<String>,
    pub title: String,
    pub title_source: Option<String>,
    pub title_message_id: Option<String>,
    pub version: String,
    pub share_url: Option<String>,
    pub permission: Option<Value>,
    pub time_created: Option<i64>,
    pub time_updated: Option<i64>,
}

/// A nullable column in an update: keep, clear (`null`) or set.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Patch<T> {
    #[default]
    Keep,
    Clear,
    Set(T),
}

impl<T: Clone> Patch<T> {
    pub(super) fn given(&self) -> bool {
        !matches!(self, Self::Keep)
    }
}

/// Node `UpdateSessionInput`.
#[derive(Clone, Debug, Default)]
pub struct Update {
    pub id: String,
    pub directory: Option<String>,
    pub path: Patch<String>,
    pub title: Option<String>,
    pub expected_title_sources: Vec<String>,
    pub title_source: Option<String>,
    pub title_message_id: Patch<String>,
    pub share_url: Patch<String>,
    pub summary: Patch<Summary>,
    pub revert: Patch<Value>,
    pub permission: Patch<Value>,
    pub time_compacting: Patch<i64>,
    pub time_updated: Option<i64>,
    pub last_outcome: Option<String>,
}

/// Node `SessionLastOutcome`: unknown persisted values read as absent.
pub const LAST_OUTCOMES: [&str; 3] = ["completed", "error", "interrupted"];

fn last_outcome(value: Option<String>) -> Option<String> {
    value.filter(|v| LAST_OUTCOMES.contains(&v.as_str()))
}

fn json_column(row: &Row, name: &str) -> rusqlite::Result<Option<Value>> {
    let text: Option<String> = row.get(name)?;
    text.map(|t| {
        serde_json::from_str(&t).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
    })
    .transpose()
}

/// Node `decodeSessionRow`: unknown task types and title sources fall back.
fn decode(row: &Row) -> rusqlite::Result<SessionRow> {
    let nonempty = |v: Option<String>| v.filter(|s| !s.is_empty());
    let task_type: Option<String> = row.get("task_type")?;
    let title_source: Option<String> = row.get("title_source")?;
    Ok(SessionRow {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        workspace_id: nonempty(row.get("workspace_id")?),
        parent_id: nonempty(row.get("parent_id")?),
        trace_id: nonempty(row.get("trace_id")?),
        task_type: task_type
            .filter(|t| TASK_TYPES.contains(&t.as_str()))
            .unwrap_or_else(|| "interactive".into()),
        slug: row.get("slug")?,
        directory: row.get("directory")?,
        path: row.get("path")?,
        title: row.get("title")?,
        title_source: title_source
            .filter(|t| TITLE_SOURCES.contains(&t.as_str()))
            .unwrap_or_else(|| "first_input".into()),
        title_message_id: nonempty(row.get("title_message_id")?),
        version: row.get("version")?,
        share_url: row.get("share_url")?,
        summary: Summary {
            additions: row.get("summary_additions")?,
            deletions: row.get("summary_deletions")?,
            files: row.get("summary_files")?,
            diffs: json_column(row, "summary_diffs")?,
        },
        revert: json_column(row, "revert")?,
        permission: json_column(row, "permission")?,
        time_created: row.get("time_created")?,
        time_updated: row.get("time_updated")?,
        time_title_updated: row.get("time_title_updated")?,
        time_compacting: row.get("time_compacting")?,
        time_archived: row.get("time_archived")?,
        time_deleted: row.get("time_deleted")?,
        last_outcome: last_outcome(row.get("last_outcome")?),
    })
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<SessionRow>> {
    conn.prepare_cached("select * from session where id = ?")?
        .query_row([id], decode)
        .optional()
}

pub(super) fn must_get(conn: &Connection, id: &str) -> anyhow::Result<SessionRow> {
    get(conn, id)?.ok_or_else(|| anyhow::anyhow!("Session not found after write: {id}"))
}

/// Node `createSession` (an upsert that keeps the first trace and time_created).
pub fn create(conn: &Connection, input: &Create, now: i64) -> anyhow::Result<SessionRow> {
    let created = input.time_created.unwrap_or(now);
    let updated = input.time_updated.unwrap_or(created);
    let titled = input.title_source.as_deref().is_some_and(|s| !s.is_empty())
        || input
            .title_message_id
            .as_deref()
            .is_some_and(|s| !s.is_empty());
    conn.prepare_cached(
        "insert into session (
        id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
        title, title_source, title_message_id, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, time_title_updated,
        time_compacting, time_archived
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, ?, ?, ?, ?, null, null)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        parent_id = excluded.parent_id,
        trace_id = coalesce(session.trace_id, excluded.trace_id),
        task_type = excluded.task_type,
        slug = excluded.slug,
        directory = excluded.directory,
        path = excluded.path,
        title = excluded.title,
        title_source = excluded.title_source,
        title_message_id = excluded.title_message_id,
        version = excluded.version,
        share_url = excluded.share_url,
        permission = coalesce(excluded.permission, session.permission),
        time_title_updated = excluded.time_title_updated,
        time_updated = excluded.time_updated",
    )?
    .execute(params![
        input.id,
        input.project_id,
        input.workspace_id,
        input.parent_id,
        input.trace_id,
        input.task_type.as_deref().unwrap_or("interactive"),
        input.slug,
        input.directory,
        input.path,
        input.title,
        input.title_source.as_deref().unwrap_or("first_input"),
        input.title_message_id,
        input.version,
        input.share_url,
        input.permission.as_ref().and_then(encode),
        created,
        updated,
        titled.then_some(updated),
    ])?;
    must_get(conn, &input.id)
}

/// Node `ListSessionsInput`.
#[derive(Clone, Debug, Default)]
pub struct List {
    pub project_id: Option<String>,
    /// `Some(None)`: `workspace_id is null`.
    pub workspace_id: Option<Option<String>>,
    pub directory: Option<String>,
    pub path: Option<String>,
    pub roots: bool,
    pub task_types: Vec<String>,
    pub limit: Option<i64>,
}

/// Node `listSessions` (`order by time_updated desc, id desc`).
pub fn list(conn: &Connection, input: &List) -> rusqlite::Result<Vec<SessionRow>> {
    // Node `listSessions`: a soft-deleted row is never returned. `includeArchived` is a
    // deprecated no-op; the historical `time_archived` column no longer filters anything.
    let mut clauses: Vec<String> = vec!["time_deleted is null".into()];
    let mut values: Vec<Sql> = vec![];
    let text = |v: &str| Sql::Text(v.to_owned());
    if let Some(project) = input.project_id.as_deref().filter(|p| !p.is_empty()) {
        clauses.push("project_id = ?".into());
        values.push(text(project));
    }
    match &input.workspace_id {
        None => {}
        Some(None) => clauses.push("workspace_id is null".into()),
        Some(Some(workspace)) => {
            clauses.push("workspace_id = ?".into());
            values.push(text(workspace));
        }
    }
    if let Some(directory) = input.directory.as_deref().filter(|d| !d.is_empty()) {
        clauses.push("directory = ?".into());
        values.push(text(directory));
    }
    if let Some(path) = &input.path {
        if path.is_empty() {
            clauses.push("(path is null or path = '')".into());
        } else {
            clauses.push("(path = ? or path like ?)".into());
            values.push(text(path));
            values.push(Sql::Text(format!("{path}/%")));
        }
    }
    if input.roots {
        clauses.push("parent_id is null".into());
    }
    let mut task_types: Vec<&str> = vec![];
    for kind in &input.task_types {
        if TASK_TYPES.contains(&kind.as_str()) && !task_types.contains(&kind.as_str()) {
            task_types.push(kind);
        }
    }
    if !task_types.is_empty() {
        clauses.push(format!(
            "task_type in ({})",
            vec!["?"; task_types.len()].join(", ")
        ));
        values.extend(task_types.into_iter().map(text));
    }
    let filter = if clauses.is_empty() {
        String::new()
    } else {
        format!("where {}", clauses.join(" and "))
    };
    let limit = input.limit.filter(|l| *l > 0);
    if let Some(limit) = limit {
        values.push(Sql::Integer(limit));
    }
    let sql = format!(
        "select * from session {filter} order by time_updated desc, id desc{}",
        if limit.is_some() { " limit ?" } else { "" }
    );
    conn.prepare_cached(&sql)?
        .query_map(rusqlite::params_from_iter(values), decode)?
        .collect()
}

/// Node `touchSession`.
pub fn touch(conn: &Connection, id: &str, time_updated: i64) -> rusqlite::Result<()> {
    conn.prepare_cached("update session set time_updated = max(time_updated, ?) where id = ?")?
        .execute(params![time_updated, id])?;
    Ok(())
}

/// Node `setRevert` (a full `updateSession` that keeps the summary unless given).
pub fn set_revert(
    conn: &Connection,
    id: &str,
    revert: Value,
    summary: Option<Summary>,
    now: i64,
) -> anyhow::Result<SessionRow> {
    let update = Update {
        id: id.into(),
        revert: Patch::Set(revert),
        summary: summary.map_or(Patch::Keep, Patch::Set),
        ..Default::default()
    };
    self::update(conn, &update, now)
}
