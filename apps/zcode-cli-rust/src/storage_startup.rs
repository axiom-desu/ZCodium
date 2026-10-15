// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! `app-server --prepare-storage` flow: strict Host handshake, then either skip
//! (Host granted `reuse`) or open/migrate the single NodeStore, and finally
//! announce `startup/storagePrepared`. Mirrors TS
//! `prepareProtocolStartupStorage` (`bootstrap/src/zcode-protocol/storage-startup.ts`).
use crate::runtime::Context;
use anyhow::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::sync::mpsc;
use zcode_cli_app_server::{Sink, stdio};
use zcode_cli_core_api::Input;

/// 握手 → 可选开库/迁移 → `storagePrepared`；失败先写 failed 帧再返回错误。
pub async fn prepare_storage(
    ctx: &Context,
    path: &Path,
    input: &mut mpsc::Receiver<Input>,
    output: &mut Sink,
) -> Result<()> {
    let attempt = zcode_cli_host::id();
    let database_id = format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()));
    let reuse = match stdio::storage_prepare(path, input, output).await {
        Ok(reuse) => reuse,
        Err(error) => return fail(output, &attempt, &database_id, 1, error).await,
    };
    // reuse 只复用 Host 本轮已关闭的真实路径；不写持久 skip 标记，也不跳过迁移之外的门。
    if !reuse {
        output
            .send_values(vec![state(&attempt, &database_id, "checking", 1)])
            .await?;
        let store = match ctx.node_store().await {
            Ok(store) => store,
            Err(error) => return fail(output, &attempt, &database_id, 2, error).await,
        };
        output
            .send_values(vec![state(&attempt, &database_id, "ready", 2)])
            .await?;
        // 关闭本次连接：Host 见到 storagePrepared 且退出码 0 才会缓存该路径。
        drop(store);
    }
    output
        .send_values(vec![
            json!({"method":"startup/storagePrepared","params":{}}),
        ])
        .await?;
    Ok(())
}

fn state(attempt: &str, database_id: &str, phase: &str, sequence: u64) -> Value {
    json!({"method":"startup/storageState","params":{"schemaVersion":1,"attemptId":attempt,"sequence":sequence,"databaseId":database_id,"databaseKind":"session","phase":phase,"elapsedMs":0}})
}

/// 先写失败帧再返回原始错误；失败帧的 IO 错误不覆盖存储异常。
async fn fail(
    output: &mut Sink,
    attempt: &str,
    database_id: &str,
    sequence: u64,
    error: anyhow::Error,
) -> Result<()> {
    let mut frame = state(attempt, database_id, "failed", sequence);
    frame["params"]["errorCode"] = error_code(&error).into();
    let _ = output.send_values(vec![frame]).await;
    Err(error.context("Session storage preparation failed"))
}

/// 沿用 Node `DatabaseStartupErrorCode`：握手错误与开库错误都映射到既有码。
fn error_code(error: &anyhow::Error) -> &'static str {
    if let Some(handshake) = error.downcast_ref::<stdio::StorageHandshakeError>() {
        return handshake.code;
    }
    error
        .downcast_ref::<zcode_cli_state::node::open::StartupError>()
        .map_or("sql_failed", |error| error.code)
}
