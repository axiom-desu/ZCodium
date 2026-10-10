// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! Process liveness and start times for the trust store lock (Node
//! `os.uptime()`, `process.kill(pid, 0)` and the start-time probes).

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn uptime_seconds() -> Option<f64> {
    // sysinfo 提供与 os.uptime 同语义的系统 uptime；不以单调时钟或本地时钟伪造失败值。
    Some(sysinfo::System::uptime() as f64)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn uptime_seconds() -> Option<f64> {
    None
}

/// `kill(pid, 0)`: EPERM still means alive. Other platforms cannot probe and
/// treat an over-age lock as abandoned.
pub(crate) fn alive(pid: i64) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // 安全 kill 探测中 EPERM 仍表示目标存在；其他错误不能作为存活证据。
        matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Ok(()) | Err(nix::errno::Errno::EPERM)
        )
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Node `currentProcessStartTimeMs` = `Date.now() - os.uptime() * 1000`, which
/// is the machine's boot time rather than the process start (D15, kept).
pub(crate) fn boot_time_ms() -> i64 {
    static BOOT: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *BOOT.get_or_init(|| crate::now() as i64 - uptime_seconds().map_or(0, |s| (s * 1000.0) as i64))
}

/// Node `probeProcessStartTimeDefault` (wall-clock ms), `None` when unknown.
pub(crate) async fn process_start_ms(pid: i64) -> Option<i64> {
    if cfg!(target_os = "linux") {
        let stat = tokio::fs::read_to_string(format!("/proc/{pid}/stat"))
            .await
            .ok()?;
        let rest = &stat[stat.rfind(')')? + 2..];
        let ticks: f64 = rest.split(' ').nth(19)?.parse().ok()?;
        return Some(boot_time_ms() + (ticks * 1000.0 / 100.0) as i64);
    }
    if cfg!(target_os = "macos") {
        let output = tokio::process::Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .env("LC_ALL", "C")
            .kill_on_drop(true)
            .output()
            .await
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let parsed =
            chrono::NaiveDateTime::parse_from_str(text.trim(), "%a %b %e %H:%M:%S %Y").ok()?;
        let local = parsed.and_local_timezone(chrono::Local).earliest()?;
        return Some(local.timestamp_millis());
    }
    None
}
