// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! `v4/storage/sessionData/{deletionPreview,deletionExecute}`：确认、凭据、文件与正文顺序。
//! 释放本进程空闲驻留 → 复查同一计划 → 写删除凭据 → 删文件 → 删正文 → 移除索引投影。
use super::Engine;
use super::session_data::{object, reason};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

struct DeletionParams {
    session_id: String,
    workspace: Value,
    revision: Option<String>,
    operation_id: Option<String>,
}

fn parse_deletion_params(p: &Value, execute: bool) -> Result<DeletionParams> {
    let allowed: &[&str] = if execute {
        &["sessionId", "workspace", "revision", "operationId"]
    } else {
        &["sessionId", "workspace"]
    };
    let object = object(p, allowed)?;
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .context("sessionId: required")?
        .to_owned();
    let workspace = object
        .get("workspace")
        .filter(|value| value.is_object())
        .cloned()
        .context("workspace: required")?;
    ensure!(
        workspace
            .get("workspacePath")
            .and_then(Value::as_str)
            .is_some_and(|path| !path.is_empty()),
        "workspace.workspacePath: required"
    );
    let text = |key: &str| -> Result<Option<String>> {
        match object.get(key) {
            None => Ok(None),
            Some(value) => Ok(Some(
                value
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("{key}: expected a non-empty string"))?
                    .to_owned(),
            )),
        }
    };
    Ok(DeletionParams {
        session_id,
        workspace,
        revision: text("revision")?,
        operation_id: text("operationId")?,
    })
}

fn retained_artifacts(files: &[Value], references: &Value) -> Vec<Value> {
    let mut retained = Vec::new();
    for reference in references.as_array().into_iter().flatten() {
        let session = reference["sessionId"].as_str().unwrap_or_default();
        let artifact = reference["artifactId"].as_str().unwrap_or_default();
        let matched: Vec<Value> = files
            .iter()
            .filter(|file| {
                file["sessionId"].as_str() == Some(session)
                    && file["kind"].as_str() == Some("artifact")
                    && file["name"]
                        .as_str()
                        .is_some_and(|name| name.contains(artifact))
            })
            .map(|file| {
                let mut value = reference.clone();
                value["fileName"] = file["name"].clone();
                value
            })
            .collect();
        if matched.is_empty() {
            let mut value = reference.clone();
            value["fileName"] = json!(artifact);
            retained.push(value);
        } else {
            retained.extend(matched);
        }
    }
    retained
}

fn is_retained(file: &Value, retained: &[Value]) -> bool {
    file["kind"].as_str() == Some("artifact")
        && retained.iter().any(|reference| {
            reference["sessionId"] == file["sessionId"] && reference["fileName"] == file["name"]
        })
}

struct Preview {
    snapshot: Value,
    files: Vec<Value>,
    retained: Vec<Value>,
    blocked: Option<&'static str>,
    revision: String,
}

impl Engine {
    async fn deletion_preview(&self, params: &DeletionParams) -> Result<Preview> {
        let snapshot = self.store.session_data_inspect(&params.session_id).await?;
        let expected = params.workspace["workspacePath"]
            .as_str()
            .unwrap_or_default();
        if let Some(path) = snapshot["workspacePath"].as_str() {
            let identity = snapshot["workspaceIdentity"].as_str().unwrap_or("");
            let requested = params.workspace["workspaceIdentity"].as_str().unwrap_or("");
            if path != expected || identity != requested {
                bail!("session-data.identity-mismatch");
            }
        }
        let mut files = Vec::new();
        for id in snapshot["sessionIds"].as_array().into_iter().flatten() {
            let id = id.as_str().unwrap_or_default();
            for file in self
                .store
                .session_data_files(id)
                .await?
                .as_array()
                .into_iter()
                .flatten()
            {
                let mut file = file.clone();
                file["sessionId"] = json!(id);
                files.push(file);
            }
        }
        let retained = retained_artifacts(&files, &snapshot["references"]);
        let local_unloaded = snapshot["localRuntimeIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|id| !self.sessions.contains_key(id));
        let busy = snapshot["sessionIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|id| self.session_busy(id));
        let blocked = if snapshot["foreignRuntime"].as_bool().unwrap_or(false) || local_unloaded {
            Some("in-use")
        } else if snapshot["pendingWork"].as_bool().unwrap_or(false) || busy {
            Some("running")
        } else if snapshot["sessionIds"]
            .as_array()
            .is_none_or(|ids| ids.is_empty())
        {
            Some("not-found")
        } else {
            None
        };
        let revision = self
            .store
            .session_data_revision(&json!([
                snapshot["revision"],
                files
                    .iter()
                    .map(|file| json!([file["relativePath"], file["bytes"]]))
                    .collect::<Vec<_>>(),
                blocked,
            ]))
            .await?;
        Ok(Preview {
            snapshot,
            files,
            retained,
            blocked,
            revision,
        })
    }

    fn preview_value(&self, params: &DeletionParams, preview: &Preview) -> Value {
        json!({
            "sessionId": params.session_id,
            "revision": preview.revision,
            "sessionIds": preview.snapshot["sessionIds"].clone(),
            "forks": preview.snapshot["forks"].clone(),
            "retainedArtifacts": preview.retained,
            "deletedFiles": preview.files.iter().filter(|file| !is_retained(file, &preview.retained)).count(),
            "blockedReason": preview.blocked,
            "incomplete": preview.snapshot["deleting"].as_bool().unwrap_or(false),
            "completed": preview.snapshot["completed"].as_bool().unwrap_or(false),
        })
    }

    pub(super) async fn preview_session_deletion(&mut self, p: &Value) -> Result<Value> {
        let params = parse_deletion_params(p, false)?;
        let preview = self.deletion_preview(&params).await?;
        Ok(self.preview_value(&params, &preview))
    }

    pub(super) async fn execute_session_deletion(&mut self, p: &Value) -> Result<Value> {
        let params = parse_deletion_params(p, true)?;
        let preview = self.deletion_preview(&params).await?;
        let ids: Vec<String> = preview.snapshot["sessionIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let result = |status: &str, reason: Option<String>| {
            json!({
                "sessionId": params.session_id,
                "status": status,
                "sessionIds": ids,
                "retainedArtifacts": preview.retained.len(),
                "reason": reason,
            })
        };
        if preview.snapshot["completed"].as_bool().unwrap_or(false) {
            return Ok(result("deleted", None));
        }
        if let Some(reason) = preview.blocked {
            return Ok(result("blocked", Some(reason.to_owned())));
        }
        // 已写入凭据即代表用户已确认过计划；否则必须与预检 revision 一致。
        if !preview.snapshot["deleting"].as_bool().unwrap_or(false)
            && params.revision.as_deref() != Some(preview.revision.as_str())
        {
            return Ok(result("blocked", Some("changed".to_owned())));
        }
        if ids.iter().any(|id| self.session_busy(id)) {
            return Ok(result("blocked", Some("running".to_owned())));
        }
        // Rust 的释放会持久化并推进 revision；必须释放后再复查同一计划，再写凭据。
        for id in &ids {
            if let Err(error) = self.release_runtime_session(id).await {
                return Ok(result("blocked", Some(reason(&error))));
            }
        }
        let fresh = self.deletion_preview(&params).await?;
        if fresh.blocked.is_some()
            || fresh.snapshot["sessionIds"] != preview.snapshot["sessionIds"]
            || fresh.snapshot["forks"] != preview.snapshot["forks"]
            || fresh.snapshot["references"] != preview.snapshot["references"]
        {
            return Ok(result("blocked", Some("changed".to_owned())));
        }
        let retained: Vec<(String, String)> = preview
            .retained
            .iter()
            .map(|reference| {
                (
                    reference["sessionId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    reference["artifactId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                )
            })
            .collect();
        let operation = params.operation_id.as_deref().unwrap_or_default();
        if let Err(error) = self
            .store
            .session_data_begin(
                &params.session_id,
                fresh.snapshot["revision"].as_str().unwrap_or_default(),
                operation,
                &retained,
            )
            .await
        {
            return Ok(result("blocked", Some(reason(&error))));
        }
        let outcome = async {
            for id in &ids {
                let keep: Vec<String> = retained
                    .iter()
                    .filter(|(session, _)| session == id)
                    .map(|(_, artifact)| artifact.clone())
                    .collect();
                self.store.session_data_remove(id, &keep).await?;
            }
            self.store.session_data_complete(&params.session_id).await?;
            for id in &ids {
                self.publish_index(id, None)?;
            }
            Ok::<(), anyhow::Error>(())
        };
        match outcome.await {
            Ok(()) => Ok(result("deleted", None)),
            Err(error) => Ok(result("incomplete", Some(reason(&error)))),
        }
    }
}
