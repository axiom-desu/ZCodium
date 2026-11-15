// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! `v4/storage/sessionData/{measure,purge}`：文件与正文行只有 CLI 存储 owner 能删。
//! 本模块做参数校验、owned tree 展开、引用保留与失败语义；永久删除见 `session_deletion`。
use super::Engine;
use crate::contract::{Method, RuntimeError};
use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

struct Params {
    session_ids: Vec<String>,
    directories: Vec<Value>,
}

pub(super) fn object<'a>(p: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>> {
    p.as_object()
        .filter(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
        .ok_or_else(|| RuntimeError::invalid_params("Unsupported session data fields"))
}

pub(super) fn string_array(value: &Value, field: &str) -> Result<Vec<String>> {
    let items = value
        .as_array()
        .with_context(|| format!("{field}: required"))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(
            item.as_str()
                .filter(|id| !id.is_empty())
                .with_context(|| format!("{field}: expected a non-empty string"))?
                .to_owned(),
        );
    }
    Ok(out)
}

fn parse_data_params(p: &Value) -> Result<Params> {
    let object = object(p, &["sessionIds", "directories"])?;
    let session_ids = string_array(
        object.get("sessionIds").context("sessionIds: required")?,
        "sessionIds",
    )?;
    let directories = object
        .get("directories")
        .and_then(Value::as_array)
        .context("directories: required")?
        .clone();
    for directory in &directories {
        let entry = directory
            .as_object()
            .filter(|entry| {
                entry
                    .keys()
                    .all(|key| key == "workspacePath" || key == "workspaceIdentity")
            })
            .context("directories: invalid entry")?;
        ensure!(
            entry
                .get("workspacePath")
                .and_then(Value::as_str)
                .is_some_and(|path| !path.is_empty()),
            "directories.workspacePath: required"
        );
    }
    Ok(Params {
        session_ids,
        directories,
    })
}

fn tree_ids(trees: &Value, root: &str) -> Vec<String> {
    let ids = trees
        .get(root)
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        vec![root.to_owned()]
    } else {
        ids
    }
}

/// 附件仍被本次不删除的会话引用时整棵保留；保留一棵会让它也成为引用方，迭代到不动点。
fn referenced_roots(
    candidates: &[(String, Vec<String>)],
    referrers: &Value,
    removable: &mut BTreeSet<String>,
) -> BTreeSet<String> {
    let mut referenced = BTreeSet::new();
    loop {
        let mut changed = false;
        for (root, ids) in candidates {
            if referenced.contains(root) {
                continue;
            }
            let outside = ids.iter().any(|id| {
                referrers
                    .get(id)
                    .and_then(Value::as_array)
                    .is_some_and(|owners| {
                        owners
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|owner| !removable.contains(owner))
                    })
            });
            if !outside {
                continue;
            }
            referenced.insert(root.clone());
            for id in ids {
                removable.remove(id);
            }
            changed = true;
        }
        if !changed {
            return referenced;
        }
    }
}

pub(super) fn reason(error: &anyhow::Error) -> String {
    let text = format!("{error:#}");
    match text.strip_prefix("session-data.") {
        Some(code) => code
            .split_whitespace()
            .next()
            .unwrap_or("unavailable")
            .to_owned(),
        None => "unavailable".to_owned(),
    }
}

impl Engine {
    pub(super) async fn session_data(&mut self, method: Method, p: &Value) -> Result<Value> {
        match method {
            Method::SessionDataMeasure => {
                let params = parse_data_params(p)?;
                let trees = self.store.session_data_trees(&params.session_ids).await?;
                let mut all = Vec::new();
                let mut per_root = Vec::new();
                for root in &params.session_ids {
                    let ids = tree_ids(&trees, root);
                    all.extend(ids.iter().cloned());
                    per_root.push((root.clone(), ids));
                }
                let sizes = self.store.session_data_measure(&all).await?;
                let sessions = per_root
                    .into_iter()
                    .map(|(root, ids)| {
                        let bytes: u64 = ids
                            .iter()
                            .map(|id| sizes.get(id).and_then(Value::as_u64).unwrap_or(0))
                            .sum();
                        json!({"sessionId": root, "bytes": bytes})
                    })
                    .collect::<Vec<_>>();
                let memory = self.store.session_data_memory(&params.directories).await?;
                Ok(json!({"sessions": sessions, "memory": memory}))
            }
            Method::SessionDataPurge => self.purge_session_data(p).await,
            Method::SessionDataDeletionPreview => self.preview_session_deletion(p).await,
            Method::SessionDataDeletionExecute => self.execute_session_deletion(p).await,
            _ => Err(RuntimeError::MethodNotFound(method.as_str().into()).into()),
        }
    }

    async fn purge_session_data(&mut self, p: &Value) -> Result<Value> {
        let params = parse_data_params(p)?;
        let trees = self.store.session_data_trees(&params.session_ids).await?;
        let all: Vec<(String, Vec<String>)> = params
            .session_ids
            .iter()
            .map(|root| (root.clone(), tree_ids(&trees, root)))
            .collect();
        let running: BTreeSet<String> = all
            .iter()
            .filter(|(_, ids)| ids.iter().any(|id| self.session_busy(id)))
            .map(|(root, _)| root.clone())
            .collect();
        let candidates: Vec<(String, Vec<String>)> = all
            .iter()
            .filter(|(root, _)| !running.contains(root))
            .cloned()
            .collect();
        let mut removable: BTreeSet<String> =
            candidates.iter().flat_map(|(_, ids)| ids.clone()).collect();
        let candidate_ids: Vec<String> = removable.iter().cloned().collect();
        let referrers = self.store.session_data_referrers(&candidate_ids).await?;
        let referenced = referenced_roots(&candidates, &referrers, &mut removable);
        let mut deleted = Vec::new();
        let mut kept = Vec::new();
        let mut failed = Vec::new();
        for (root, ids) in &all {
            if running.contains(root) {
                kept.push(json!({"sessionId": root, "reason": "running"}));
                continue;
            }
            if referenced.contains(root) {
                kept.push(json!({"sessionId": root, "reason": "referenced"}));
                continue;
            }
            let outcome = async {
                for id in ids {
                    if self.sessions.contains_key(id) {
                        self.release_runtime_session(id).await?;
                    }
                }
                let mut bytes = 0u64;
                for id in ids {
                    bytes += self.store.session_data_remove(id, &[]).await?;
                }
                self.store
                    .session_data_purge(std::slice::from_ref(root))
                    .await?;
                for id in ids {
                    self.publish_index(id, None)?;
                }
                Ok::<u64, anyhow::Error>(bytes)
            };
            match outcome.await {
                Ok(bytes) => deleted.push(json!({"sessionId": root, "bytes": bytes})),
                Err(error) => failed.push(json!({"sessionId": root, "code": reason(&error)})),
            }
        }
        let mut memory = Vec::new();
        for directory in &params.directories {
            match self.store.session_data_memory_remove(directory).await {
                Ok(bytes) => memory.push(json!({
                    "workspacePath": directory["workspacePath"],
                    "bytes": bytes,
                })),
                Err(error) => failed.push(json!({
                    "workspacePath": directory["workspacePath"],
                    "code": reason(&error),
                })),
            }
        }
        Ok(json!({"deleted": deleted, "kept": kept, "failed": failed, "memory": memory}))
    }
}

#[cfg(test)]
#[path = "session_deletion_tests.rs"]
mod deletion_tests;
#[cfg(test)]
#[path = "session_data_test_support.rs"]
mod test_support;
#[cfg(test)]
#[path = "session_data_tests.rs"]
mod tests;
