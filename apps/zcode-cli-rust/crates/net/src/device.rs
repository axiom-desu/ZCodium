// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! Device id shared with Desktop through `telemetry-state.json`
//! (Node `adapters/src/device/cli-device-mid.ts`). Any failure falls back to an
//! id that is valid for this process only; the caller caches the result.
use serde_json::{Map, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const LOCK_RETRY_DELAY: Duration = Duration::from_millis(10);
const LOCK_RETRY_COUNT: usize = 200;
const LOCK_STALE: Duration = Duration::from_secs(5 * 60);

/// `${ZCODE_DATA_BASE_DIR || home}/<user-data-dir>/v2/telemetry-state.json`.
pub fn state_file(base_dir: Option<&str>, home: &Path, cwd: &Path) -> PathBuf {
    let base = base_dir.map(str::trim).filter(|b| !b.is_empty());
    let base = match base {
        None | Some("~") => home.to_path_buf(),
        Some(path) => match path.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => cwd.join(path),
        },
    };
    base.join(zcode_cli_domain::path_names::ZCODE_USER_DATA_DIR_NAME)
        .join("v2")
        .join("telemetry-state.json")
}

/// Node `ensureCliDeviceMid` without the process cache.
pub async fn ensure(state_file: &Path) -> String {
    let generated = uuid::Uuid::new_v4().to_string();
    match persisted(state_file, &generated).await {
        Ok(id) => id,
        Err(error) => {
            tracing::warn!(
                target: "zcode::net",
                event = "device.persist_failed",
                error = %error,
                "Device id is not persisted; using a process-local id"
            );
            generated
        }
    }
}

fn device_id(state: &Map<String, Value>) -> Option<String> {
    state
        .get("deviceMid")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

async fn read_state(path: &Path) -> Map<String, Value> {
    match tokio::fs::read(path)
        .await
        .map(|b| serde_json::from_slice(&b))
    {
        Ok(Ok(Value::Object(state))) => state,
        _ => Map::new(),
    }
}

async fn persisted(state_file: &Path, generated: &str) -> std::io::Result<String> {
    if let Some(id) = device_id(&read_state(state_file).await) {
        return Ok(id);
    }
    let directory = state_file.parent().unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(directory).await?;
    let lock = directory.join("telemetry-state.lock");
    for _ in 0..LOCK_RETRY_COUNT {
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .await
        {
            Ok(mut handle) => {
                let result = locked(state_file, &mut handle, generated).await;
                drop(handle);
                let _ = tokio::fs::remove_file(&lock).await;
                return result;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !remove_stale_lock(&lock).await {
                    tokio::time::sleep(LOCK_RETRY_DELAY).await;
                }
            }
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other("CLI telemetry state lock timeout"))
}

async fn locked(
    state_file: &Path,
    handle: &mut tokio::fs::File,
    generated: &str,
) -> std::io::Result<String> {
    use tokio::io::AsyncWriteExt;
    let owner = serde_json::json!({"createdAt": now_ms(), "pid": std::process::id()});
    handle.write_all(owner.to_string().as_bytes()).await?;
    let mut state = read_state(state_file).await;
    if let Some(id) = device_id(&state) {
        return Ok(id);
    }
    state.insert("deviceMid".into(), generated.into());
    write_state(state_file, &state).await?;
    Ok(generated.to_owned())
}

/// Atomic replace so Desktop never reads a torn file.
async fn write_state(path: &Path, state: &Map<String, Value>) -> std::io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let temp = directory.join(format!(
        ".{name}.{}.{}.{}.tmp",
        std::process::id(),
        now_ms(),
        uuid::Uuid::new_v4().simple()
    ));
    let body = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    let result = async {
        tokio::fs::write(&temp, body).await?;
        tokio::fs::rename(&temp, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

/// Node `removeStaleTelemetryLockIfNeeded`.
async fn remove_stale_lock(lock: &Path) -> bool {
    let Ok(metadata) = tokio::fs::metadata(lock).await else {
        return false;
    };
    let age = metadata
        .modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .unwrap_or_default();
    if age < LOCK_STALE {
        let owner = tokio::fs::read(lock)
            .await
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(|o| o["createdAt"].is_number())
            .and_then(|o| o["pid"].as_f64());
        match owner {
            None => return false,
            Some(pid) if process_alive(pid).await => return false,
            Some(_) => {}
        }
    }
    let _ = tokio::fs::remove_file(lock).await;
    true
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Node `isProcessAlive` (`process.kill(pid, 0)`; EPERM counts as alive).
async fn process_alive(pid: f64) -> bool {
    if pid.fract() != 0.0 || pid <= 0.0 || pid > f64::from(u32::MAX) {
        return false;
    }
    alive_process(pid as u32).await
}

#[cfg(unix)]
async fn alive_process(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // nix 将安全 kill 探测的 EPERM 保留为存活语义，其余错误均不证明进程存在。
    matches!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
        Ok(()) | Err(nix::errno::Errno::EPERM)
    )
}

#[cfg(windows)]
async fn alive_process(pid: u32) -> bool {
    use sysinfo::{ProcessesToUpdate, System};
    let result = tokio::task::spawn_blocking(move || {
        let mut system = System::new();
        let target = sysinfo::Pid::from_u32(pid);
        let refreshed = system.refresh_processes(ProcessesToUpdate::All, true);
        (refreshed, system.process(target).is_some())
    })
    .await;
    match result {
        // 全量进程快照有结果且目标缺席才确认退出；空表无法区分权限问题与退出。
        Ok((refreshed, present)) => present || refreshed == 0,
        // 查询失败/任务取消是 unknown，不能回收锁。
        Err(_) => true,
    }
}

#[cfg(not(any(unix, windows)))]
async fn alive_process(_pid: u32) -> bool {
    true
}
