//! `v4/sessionsIndex/reconcile` over the Node `session` table.
//!
//! Sibling of the TypeScript CLI's `v4-bridge-session-reconcile.ts`: the caller
//! asks for explicit IDs because a missing snapshot is not a deletion. This is a
//! read-only projection — it never activates, resumes, writes or pages, and a
//! soft-deleted row of the same workspace is reported as `deleted: true`.
use super::sessions;
use anyhow::{Result, bail};
use rusqlite::Connection;
use serde_json::{Value, json};
use zcode_cli_domain::workspace_identity::parse_remote;

/// Node `normalizeStoredTitleSource`: unknown historical values project as generated.
fn title_source(source: &str) -> &'static str {
    match source {
        "custom" => "custom",
        "default" => "default",
        _ => "generated",
    }
}

/// Node `sessionLastOutcomeSchema`: only the three persisted terminal results are readable.
fn last_outcome(value: Option<&str>, id: &str) -> Result<Option<&'static str>> {
    value
        .map(|outcome| match outcome {
            "completed" => Ok("completed"),
            "error" => Ok("error"),
            "interrupted" => Ok("interrupted"),
            other => bail!("Invalid stored lastOutcome for {id}: {other}"),
        })
        .transpose()
}

/// Node `getSession(id)` plus the same-workspace proof of the TS reconcile handler:
/// remote identities match only their own `workspace_id`; a local workspace accepts
/// sessions without an identity or with exactly that identity.
fn same_workspace(
    row: &sessions::SessionRow,
    workspace_id: &str,
    remote_path: Option<&str>,
) -> bool {
    let directory = remote_path.unwrap_or(workspace_id);
    if row.directory != directory {
        return false;
    }
    let identity = row.workspace_id.as_deref();
    match remote_path {
        Some(_) => identity == Some(workspace_id),
        None => identity.is_none_or(|value| value == workspace_id),
    }
}

/// The strict `sessionsIndexReconcileResultSchema` payload, in request order.
pub fn sessions(conn: &Connection, workspace_id: &str, ids: &[String]) -> Result<Value> {
    let remote = parse_remote(workspace_id).map(|remote| remote.path);
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(row) = sessions::get(conn, id)? else {
            out.push(json!({"sessionId": id, "exists": false, "deleted": false}));
            continue;
        };
        if !same_workspace(&row, workspace_id, remote) {
            out.push(json!({"sessionId": id, "exists": false, "deleted": false}));
            continue;
        }
        let mut entry = json!({
            "sessionId": row.id,
            "exists": true,
            "deleted": row.time_deleted.is_some(),
            "title": row.title,
            "titleSource": title_source(&row.title_source),
            "createdAt": row.time_created.max(0) as u64,
            "updatedAt": row.time_updated.max(0) as u64,
        });
        if let Some(outcome) = last_outcome(row.last_outcome.as_deref(), id)? {
            entry["lastOutcome"] = outcome.into();
        }
        out.push(entry);
    }
    Ok(json!({"sessions": out}))
}

#[cfg(test)]
#[path = "reconcile_tests.rs"]
mod tests;
