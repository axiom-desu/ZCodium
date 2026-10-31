//! `v4/sessionsIndex/reconcile`: explicit-ID reads of persisted CLI facts.
//!
//! Mirrors the TypeScript `sessionsIndexReconcileParamsSchema` /
//! `sessionsIndexReconcileResultSchema` boundary: a missing snapshot is not a
//! deletion, paging/epochs are never inferred, and an unavailable store fails
//! instead of returning an empty success.
use super::Engine;
use anyhow::{Context, Result, ensure};
use serde_json::Value;

const MAX_IDS: usize = 256;

struct Params {
    workspace_id: String,
    session_ids: Vec<String>,
}

fn parse(p: &Value) -> Result<Params> {
    let object = p
        .as_object()
        .context("Reconcile params must be an object")?;
    for key in object.keys() {
        ensure!(
            matches!(key.as_str(), "workspaceId" | "sessionIds"),
            "Unrecognized key: {key}"
        );
    }
    let workspace_id = object
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("workspaceId: required")?
        .to_owned();
    let items = object
        .get("sessionIds")
        .and_then(Value::as_array)
        .context("sessionIds: required")?;
    ensure!(items.len() <= MAX_IDS, "sessionIds: too many entries");
    let mut session_ids = Vec::with_capacity(items.len());
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        let id = item
            .as_str()
            .filter(|value| !value.is_empty())
            .context("sessionIds: expected a non-empty string")?;
        if seen.insert(id.to_owned()) {
            session_ids.push(id.to_owned());
        }
    }
    Ok(Params {
        workspace_id,
        session_ids,
    })
}

impl Engine {
    pub(super) async fn reconcile_sessions(&mut self, p: &Value) -> Result<Value> {
        let params = parse(p)?;
        let result = self
            .store
            .reconcile_sessions(&params.workspace_id, &params.session_ids)
            .await?;
        // 响应必须是完整 strict schema；不静默裁剪或补造事实。
        validate(&result)?;
        Ok(result)
    }
}

fn validate(result: &Value) -> Result<()> {
    let sessions = result
        .get("sessions")
        .and_then(Value::as_array)
        .context("Reconcile result must list sessions")?;
    ensure!(
        sessions.len() <= MAX_IDS,
        "Reconcile result exceeds frame budget"
    );
    for entry in sessions {
        let object = entry
            .as_object()
            .context("Reconcile session entry must be an object")?;
        let exists = object
            .get("exists")
            .and_then(Value::as_bool)
            .context("Reconcile entry requires exists")?;
        let allowed: &[&str] = if exists {
            &[
                "sessionId",
                "exists",
                "deleted",
                "title",
                "titleSource",
                "createdAt",
                "updatedAt",
                "lastOutcome",
            ]
        } else {
            &["sessionId", "exists", "deleted"]
        };
        for key in object.keys() {
            ensure!(
                allowed.contains(&key.as_str()),
                "Unrecognized reconcile field: {key}"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "session_reconcile_tests.rs"]
mod tests;
