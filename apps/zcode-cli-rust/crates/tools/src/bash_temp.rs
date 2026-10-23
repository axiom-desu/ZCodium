//! Bash 合并输出的 tmp 隔离：spawn 之前冻结路径与写句柄，tmp 不可用时按 Node
//! `BASH_TEMP_UNAVAILABLE_CODES` 的精确 errno 集合降级回原有 artifacts 输出路径。
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Node `BASH_TEMP_DIRECTORY_PREFIX`；每个进程生命周期只创建一次。
const TEMP_ROOT_PREFIX: &str = "zcode-bash-";

/// 一条已经冻结的 Bash 输出：路径与句柄都在 spawn 之前确定。
pub(super) struct PreparedOutput {
    pub(super) path: PathBuf,
    /// 与 capture 共享的合并输出句柄；spawn 之后只写这一份。
    pub(super) combined: Arc<Mutex<tokio::fs::File>>,
    /// 本次新建的空文件；准备期取消只删除自己创建的文件。
    created: bool,
}

/// 进程生命周期内唯一的 tmp 根；创建失败不缓存，下一次 Bash 可以重试。
#[derive(Default)]
pub(super) struct TempRoot(Mutex<Option<PathBuf>>);

impl TempRoot {
    async fn get(&self, parent: &Path) -> Result<PathBuf> {
        let mut root = self.0.lock().await;
        if let Some(existing) = root.as_ref() {
            return Ok(existing.clone());
        }
        let candidate = parent.join(format!("{TEMP_ROOT_PREFIX}{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&candidate).await.with_context(|| {
            format!("Cannot create Bash temp directory {}", candidate.display())
        })?;
        *root = Some(candidate.clone());
        Ok(candidate)
    }
}

/// 冻结 Bash 输出；降级根始终来自原有 artifacts 配置，不沿用任何已缓存的 tmp 路径。
pub(super) async fn prepare(
    temp_parent: Option<&Path>,
    artifacts: &Path,
    id: &str,
    temp_root: &TempRoot,
) -> Result<PreparedOutput> {
    let file = format!("{id}.output");
    let fallback = artifacts.join(&file);
    if let Some(parent) = temp_parent {
        let attempt = async {
            let root = temp_root.get(parent).await?;
            let session = artifacts.file_name().with_context(|| {
                format!(
                    "Bash artifacts {} has no session segment",
                    artifacts.display()
                )
            })?;
            create(root.join(session).join(&file)).await
        }
        .await;
        match attempt {
            Ok(prepared) => return Ok(prepared),
            // 只有 Node 列出的 errno 才降级；其它错误必须显式报准备失败，不能静默换路径。
            Err(error) if !is_unavailable(&error) => return Err(error),
            Err(_) => {}
        }
    }
    create(fallback).await
}

/// 准备期取消/关闭：关闭句柄，只删除本次新建的、未被 spawn 使用的空文件。
pub(super) async fn discard(prepared: PreparedOutput) {
    let PreparedOutput {
        path,
        combined,
        created,
    } = prepared;
    drop(combined);
    if created {
        // 清理失败不能覆盖取消/spawn 的真实结果，也不能删除原有的非空输出。
        let _ = tokio::fs::remove_file(&path).await;
    }
}

async fn create(path: PathBuf) -> Result<PreparedOutput> {
    let prepare = || format!("Cannot prepare Bash output {}", path.display());
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(prepare)?;
    }
    let created = !tokio::fs::try_exists(&path).await.with_context(prepare)?;
    let file = open_output(&path).await.with_context(prepare)?;
    Ok(PreparedOutput {
        path,
        combined: Arc::new(Mutex::new(file)),
        created,
    })
}

/// Node Windows 用 `w`（截断），POSIX 用 `O_APPEND|O_NOFOLLOW`；两条语义都要对齐。
async fn open_output(path: &Path) -> std::io::Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true);
    if cfg!(windows) {
        options.write(true).truncate(true);
    } else {
        options.append(true);
        // tokio 在 unix 上直接提供 custom_flags，与 Node 的 O_NOFOLLOW 对齐。
        #[cfg(unix)]
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    options.open(path).await
}

/// Node `BASH_TEMP_UNAVAILABLE_CODES`：EACCES/EPERM/EROFS/ENOENT/ENOTDIR/ENOSPC/EDQUOT。
fn is_unavailable(error: &anyhow::Error) -> bool {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
        .is_some_and(unavailable_code)
}

#[cfg(unix)]
fn unavailable_code(error: &std::io::Error) -> bool {
    use nix::errno::Errno;
    let Some(code) = error.raw_os_error() else {
        return false;
    };
    matches!(
        Errno::from_raw(code),
        Errno::EACCES
            | Errno::EPERM
            | Errno::EROFS
            | Errno::ENOENT
            | Errno::ENOTDIR
            | Errno::ENOSPC
            | Errno::EDQUOT
    )
}

#[cfg(not(unix))]
fn unavailable_code(error: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    // Windows 的 tmp 不可用错误：FILE/PATH_NOT_FOUND、ACCESS_DENIED、WRITE_PROTECT、
    // HANDLE_DISK_FULL、DISK_FULL、NOT_ENOUGH_QUOTA。
    matches!(
        error.kind(),
        ErrorKind::PermissionDenied | ErrorKind::NotFound
    ) || matches!(error.raw_os_error(), Some(2 | 3 | 5 | 19 | 39 | 112 | 1816))
}

impl crate::tools::WorkspaceTools {
    /// 覆盖 Bash 输出 tmp 父目录（测试/受限平台）；`None` 表示只用 artifacts。
    pub fn with_bash_temp_parent(mut self, parent: Option<PathBuf>) -> Self {
        self.shell = crate::tool_shell::ShellTasks::new(self.env.clone(), parent);
        self
    }
}
