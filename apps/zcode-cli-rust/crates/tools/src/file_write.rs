//! Crash-safe file replacement, shared by Write/Edit, file rewind and plan
//! files. Structured patch generation lives in `file_diff`.
use super::tools::check_cancel;
use anyhow::{Context, Result, bail};
use std::path::Path;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub(super) async fn atomic_write(
    path: &Path,
    bytes: &[u8],
    expected: Option<&[u8]>,
    cancel: &CancellationToken,
) -> Result<()> {
    check_cancel(cancel)?;
    let parent = path.parent().context("File requires a parent directory")?;
    tokio::fs::create_dir_all(parent).await?;
    let temp = parent.join(format!(".zcode-{}.tmp", super::id()));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await?;
        if let Ok(meta) = tokio::fs::metadata(path).await {
            file.set_permissions(meta.permissions()).await?;
        }
        file.write_all(bytes).await?;
        file.sync_all().await?;
        drop(file);
        check_cancel(cancel)?;
        let actual = match tokio::fs::read(path).await {
            Ok(v) => Some(v),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        // 原子替换前再次核对观察版本，避免等待 IO 时覆盖外部写入。
        if actual.as_deref() != expected {
            bail!("stale_file: changed before atomic commit");
        }
        tokio::fs::rename(&temp, path).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(temp).await;
    }
    result
}
