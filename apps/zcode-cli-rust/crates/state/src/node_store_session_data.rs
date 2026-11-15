// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! `v4/storage/sessionData/*` 的存储适配：唯一连接线程执行 DB 写读，文件操作在阻塞线程。
use super::node::{session_data, session_data_files, session_data_inspect};
use super::node_store::{NodeStore, Request};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use sha2::Digest as _;

fn directory(entry: &Value) -> Result<(String, Option<String>)> {
    let object = entry
        .as_object()
        .context("Workspace directory must be an object")?;
    let path = object
        .get("workspacePath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("workspacePath: required")?
        .to_owned();
    let identity = object
        .get("workspaceIdentity")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    Ok((path, identity))
}

impl NodeStore {
    pub(super) async fn session_data_request(
        &self,
        run: impl FnOnce(&rusqlite::Connection) -> Result<Value> + Send + Sync + 'static,
    ) -> Result<Value> {
        self.request(|reply| Request::SessionData(Box::new(run), reply))
            .await
    }
}

impl NodeStore {
    pub(super) async fn session_data_trees_inner(&self, ids: &[String]) -> Result<Value> {
        let ids = ids.to_vec();
        self.session_data_request(move |conn| {
            let trees = session_data::owned_trees(conn, &ids)?;
            Ok(serde_json::to_value(trees)?)
        })
        .await
    }

    pub(super) async fn session_data_referrers_inner(&self, ids: &[String]) -> Result<Value> {
        let ids = ids.to_vec();
        self.session_data_request(move |conn| {
            let referrers = session_data::artifact_referrers(conn, &ids)?;
            Ok(serde_json::to_value(referrers)?)
        })
        .await
    }

    pub(super) async fn session_data_measure_inner(&self, ids: &[String]) -> Result<Value> {
        let mut result = serde_json::Map::new();
        for id in ids {
            let root = self.storage_root.clone();
            let key = id.clone();
            let session = key.clone();
            let bytes =
                tokio::task::spawn_blocking(move || session_data_files::measure(&root, &session))
                    .await??;
            result.insert(key, json!(bytes));
        }
        Ok(Value::Object(result))
    }

    pub(super) async fn session_data_memory_inner(&self, directories: &[Value]) -> Result<Value> {
        let mut result = Vec::new();
        for entry in directories {
            let (workspace_path, identity) = directory(entry)?;
            let root = self.storage_root.clone();
            let path = workspace_path.clone();
            let bytes = tokio::task::spawn_blocking(move || {
                session_data_files::measure_memory(&root, &path, identity.as_deref())
            })
            .await??;
            result.push(json!({"workspacePath": workspace_path, "bytes": bytes}));
        }
        Ok(Value::Array(result))
    }

    pub(super) async fn session_data_remove_inner(
        &self,
        id: &str,
        retained: &[String],
    ) -> Result<u64> {
        let root = self.storage_root.clone();
        let id = id.to_owned();
        let retained = retained.to_vec();
        tokio::task::spawn_blocking(move || session_data_files::remove(&root, &id, &retained))
            .await?
    }

    pub(super) async fn session_data_memory_remove_inner(&self, entry: &Value) -> Result<u64> {
        let (workspace_path, identity) = directory(entry)?;
        let root = self.storage_root.clone();
        tokio::task::spawn_blocking(move || {
            session_data_files::remove_memory(&root, &workspace_path, identity.as_deref())
        })
        .await?
    }

    pub(super) async fn session_data_files_inner(&self, id: &str) -> Result<Value> {
        let root = self.storage_root.clone();
        let id = id.to_owned();
        let files =
            tokio::task::spawn_blocking(move || session_data_files::list(&root, &id)).await??;
        Ok(Value::Array(files))
    }

    pub(super) async fn session_data_purge_inner(&self, ids: &[String]) -> Result<()> {
        let ids = ids.to_vec();
        self.session_data_request(move |conn| {
            session_data::purge(conn, &ids)?;
            Ok(Value::Null)
        })
        .await?;
        Ok(())
    }

    pub(super) async fn session_data_revision_inner(&self, parts: &Value) -> Result<String> {
        let encoded = serde_json::to_string(parts)?;
        Ok(format!("{:x}", sha2::Sha256::digest(encoded.as_bytes())))
    }

    pub(super) async fn session_data_inspect_inner(&self, id: &str) -> Result<Value> {
        let id = id.to_owned();
        let owner = self.owner_id.clone();
        self.session_data_request(move |conn| session_data_inspect::inspect(conn, &id, &owner))
            .await
    }

    pub(super) async fn session_data_begin_inner(
        &self,
        id: &str,
        revision: &str,
        operation_id: &str,
        retained: &[(String, String)],
    ) -> Result<()> {
        let id = id.to_owned();
        let owner = self.owner_id.clone();
        let revision = revision.to_owned();
        let operation_id = operation_id.to_owned();
        let retained = retained.to_vec();
        self.session_data_request(move |conn| {
            session_data::begin(conn, &id, &owner, &revision, &operation_id, &retained)?;
            Ok(Value::Null)
        })
        .await?;
        Ok(())
    }

    pub(super) async fn session_data_complete_inner(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.session_data_request(move |conn| {
            session_data::complete(conn, &id)?;
            Ok(Value::Null)
        })
        .await?;
        Ok(())
    }

    pub(super) async fn session_presence_register_inner(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        let owner = self.owner_id.clone();
        self.session_data_request(move |conn| {
            session_data::register_presence(conn, &owner, &id)?;
            Ok(Value::Null)
        })
        .await?;
        Ok(())
    }

    pub(super) async fn session_presence_unregister_inner(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        let owner = self.owner_id.clone();
        self.session_data_request(move |conn| {
            session_data::unregister_presence(conn, &owner, &id)?;
            Ok(Value::Null)
        })
        .await?;
        Ok(())
    }
}
