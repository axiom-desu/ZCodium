// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
use crate::{
    contract::ContextPort,
    domain::prompt::{InstructionRead, InstructionSource, PromptSnapshot},
};
use anyhow::Result;
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

pub struct WorkspaceContext {
    cwd: PathBuf,
    home: PathBuf,
    desktop: bool,
    env: std::sync::Arc<[(String, String)]>,
    /// 项目记忆根（`<cli>/memories/projects/<slug>-<hash>/memory`）；未启用时为 None。
    memory_root: Option<PathBuf>,
}
impl WorkspaceContext {
    /// `env` is the sanitized runtime environment used by git and OS probes.
    pub fn new(
        cwd: PathBuf,
        home: PathBuf,
        desktop: bool,
        env: std::sync::Arc<[(String, String)]>,
        memory_root: Option<PathBuf>,
    ) -> Self {
        Self {
            cwd,
            home,
            desktop,
            env,
            memory_root,
        }
    }
}
#[async_trait::async_trait]
impl ContextPort for WorkspaceContext {
    fn desktop(&self) -> bool {
        self.desktop
    }
    async fn snapshot(&self, cancel: &CancellationToken) -> Result<PromptSnapshot> {
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            other => other,
        };
        let probe = super::context_git::Probe {
            cwd: &self.cwd,
            env: &self.env,
        };
        let (git, release) = tokio::join!(
            super::context_git::snapshot(&probe, cancel),
            super::context_git::os_release(&probe, cancel),
        );
        anyhow::ensure!(!cancel.is_cancelled(), "Cancelled");
        Ok(PromptSnapshot {
            cwd: self.cwd.to_string_lossy().into_owned(),
            platform: platform.into(),
            shell: if cfg!(windows) { "cmd.exe" } else { "bash" }.into(),
            os_version: format!("{platform} {} {arch}", release.trim()),
            current_date: chrono::Local::now().format("%Y-%m-%d").to_string(),
            git,
        })
    }
    async fn instructions(&self, cancel: &CancellationToken) -> Result<InstructionRead> {
        tokio::select! { biased;
            _=cancel.cancelled()=>anyhow::bail!("Cancelled"),
            sources=read_instructions(&self.cwd, &self.home, self.memory_root.as_deref())=>Ok(sources),
        }
    }
}
/// 读取指令文件。**存在但读不出来**的路径进 `unreadable`（不算删除）；
/// 不存在或不是普通文件不是声明，静默跳过（与上游 MISSING 语义一致）。
async fn read_instructions(cwd: &Path, home: &Path, memory_root: Option<&Path>) -> InstructionRead {
    // TS 只选择最近文件，并在最近 Git 根停止；不能把父目录或隐藏候选全量拼接进请求。
    let mut candidates = vec![(
        home.join(crate::domain::path_names::LEGACY_ZCODE_USER_DATA_DIR_NAME)
            .join("AGENTS.md"),
        true,
    )];
    for directory in cwd.ancestors() {
        let candidate = directory.join("AGENTS.md");
        if tokio::fs::metadata(&candidate)
            .await
            .is_ok_and(|m| m.is_file())
        {
            if candidate != candidates[0].0 {
                candidates.push((candidate, false));
            }
            break;
        }
        if tokio::fs::metadata(directory.join(".git")).await.is_ok() {
            break;
        }
    }
    let mut read = InstructionRead::default();
    for (path, user) in candidates {
        match tokio::fs::metadata(&path).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                unreadable(&mut read, &path, &error);
                continue;
            }
            // 目录/设备不是指令声明，不算读取失败。
            Ok(meta) if !meta.is_file() => continue,
            Ok(_) => {}
        }
        match read_source(&path, user).await {
            Ok(source) => read.sources.push(source),
            Err(error) => unreadable(&mut read, &path, &error),
        }
    }
    // 3.18 F1 auto-memory：项目记忆索引作为独立指令来源（类型 auto-memory）。
    if let Some(root) = memory_root {
        let path = root.join(crate::domain::memory::MEMORY_INDEX_FILE_NAME);
        match tokio::fs::metadata(&path).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => unreadable(&mut read, &path, &error),
            Ok(meta) if !meta.is_file() => {}
            Ok(_) => match tokio::fs::read_to_string(&path).await {
                Ok(content) => {
                    let body = crate::domain::memory::format_index(&content);
                    if !body.is_empty() {
                        read.sources.push(InstructionSource {
                            path: path.to_string_lossy().into_owned(),
                            user: false,
                            content: body,
                            truncated: false,
                            kind: Some(crate::domain::instruction_files::TYPE_AUTO_MEMORY.into()),
                        });
                    }
                }
                Err(error) => unreadable(&mut read, &path, &error),
            },
        }
    }
    read
}
fn unreadable(read: &mut InstructionRead, path: &Path, error: &dyn std::fmt::Display) {
    tracing::warn!(
        target: "zcode::context",
        event = "context.instructions.read_failed",
        path = %path.display(),
        error = %error,
        "Instruction file read failed"
    );
    read.unreadable.push(path.to_string_lossy().into_owned());
}
async fn read_source(path: &Path, user: bool) -> Result<InstructionSource> {
    const MAX_BYTES: u64 = 100 * 1024;
    let meta = tokio::fs::metadata(path).await?;
    anyhow::ensure!(meta.is_file(), "Instructions must be a regular file");
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::with_capacity(meta.len().min(MAX_BYTES) as usize);
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).await?;
    let truncated = meta.len() > MAX_BYTES || bytes.len() > MAX_BYTES as usize;
    bytes.truncate(MAX_BYTES as usize);
    Ok(InstructionSource {
        path: path.to_string_lossy().into_owned(),
        user,
        content: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
        kind: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn same_user_and_workspace_path_is_injected_once_and_non_files_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root
            .path()
            .join(crate::domain::path_names::ZCODE_WORKSPACE_CONFIG_DIR_NAME);
        tokio::fs::create_dir_all(cwd.join(".git")).await.unwrap();
        tokio::fs::write(cwd.join("AGENTS.md"), "one source")
            .await
            .unwrap();
        let sources = read_instructions(&cwd, root.path(), None).await;
        assert_eq!(sources.sources.len(), 1);
        assert!(sources.sources[0].user);
        assert_eq!(sources.sources[0].content, "one source");
        tokio::fs::remove_file(cwd.join("AGENTS.md")).await.unwrap();
        tokio::fs::create_dir(cwd.join("AGENTS.md")).await.unwrap();
        tokio::fs::write(root.path().join("AGENTS.md"), "outside git boundary")
            .await
            .unwrap();
        assert!(
            read_instructions(&cwd, root.path(), None)
                .await
                .sources
                .is_empty()
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn a_present_but_unreadable_file_is_not_a_declaration() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("w");
        tokio::fs::create_dir_all(cwd.join(".git")).await.unwrap();
        let path = cwd.join("AGENTS.md");
        tokio::fs::write(&path, "secret").await.unwrap();
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000))
            .await
            .unwrap();
        let read = read_instructions(&cwd, root.path(), None).await;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .await
            .unwrap();
        assert!(read.sources.is_empty());
        assert_eq!(read.unreadable, vec![path.to_string_lossy().to_string()]);
    }
    #[tokio::test]
    async fn cancelled_context_initialization_does_not_return_a_snapshot_or_sources() {
        let root = tempfile::tempdir().unwrap();
        let source = WorkspaceContext::new(
            root.path().into(),
            root.path().into(),
            false,
            std::env::vars().collect(),
            None,
        );
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(source.snapshot(&cancel).await.is_err());
        assert!(source.instructions(&cancel).await.is_err());
    }
}
