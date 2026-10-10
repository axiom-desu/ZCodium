// ZCodium 下游修改，契约/存储/安全边界适配，来源及许可见 Rust 根 NOTICE.md
//! Host facts reported in identity headers, named the way Node reports them
//! (`Intl` locale and time zone, `process.platform`, `os.arch()`, `os.release()`).
use std::path::Path;

/// ICU default locale as BCP 47: the first *present* of `LC_ALL`, `LC_MESSAGES`,
/// `LANG`; `C`/`POSIX` and absence map to `en-US`, an empty value to `und`.
pub fn language<'a>(env: impl Fn(&str) -> Option<&'a str>) -> String {
    let Some(raw) = ["LC_ALL", "LC_MESSAGES", "LANG"].into_iter().find_map(&env) else {
        return "en-US".into();
    };
    let (locale, modifier) = match raw.split_once('@') {
        Some((locale, modifier)) => (locale, Some(modifier)),
        None => (raw, None),
    };
    let locale = locale.split('.').next().unwrap_or("");
    match locale {
        "C" | "POSIX" => return "en-US".into(),
        "" => return "und".into(),
        _ => {}
    }
    let mut tag = locale.replace('_', "-");
    if let Some(modifier) = modifier.filter(|m| !m.is_empty()) {
        tag.push('-');
        tag.push_str(modifier);
    }
    tag
}

/// IANA time zone like `Intl.DateTimeFormat().resolvedOptions().timeZone`.
/// `None` when `TZ` names an unknown zone (Node reports `undefined`).
pub fn timezone<'a>(env: impl Fn(&str) -> Option<&'a str>) -> Option<String> {
    let Some(tz) = env("TZ") else {
        return iana_time_zone::get_timezone().ok();
    };
    let tz = tz.strip_prefix(':').unwrap_or(tz);
    if tz.is_empty() {
        return Some("Etc/Unknown".into());
    }
    let known = tz.eq_ignore_ascii_case("UTC")
        || (!tz.contains("..") && Path::new("/usr/share/zoneinfo").join(tz).is_file());
    known.then(|| tz.to_owned())
}

pub struct Os {
    pub platform: &'static str,
    pub arch: &'static str,
    pub category: &'static str,
    pub release: Option<String>,
}

/// `process.platform`, `os.arch()`, `os.release()` and the Node OS category.
pub fn os() -> Os {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        other => other,
    };
    let category = match platform {
        "darwin" => "macos",
        "win32" => "windows",
        _ => "linux",
    };
    Os {
        platform,
        arch,
        category,
        release: release(),
    }
}

#[cfg(unix)]
fn release() -> Option<String> {
    // nix 封装 uname 的初始化与 FFI；解码失败继续报告 unknown，不制造版本号。
    nix::sys::utsname::uname()
        .ok()?
        .release()
        .to_str()
        .map(str::to_owned)
}

#[cfg(windows)]
fn release() -> Option<String> {
    let version = windows_version::OsVersion::current();
    Some(format!(
        "{}.{}.{}",
        version.major, version.minor, version.build
    ))
}

#[cfg(not(any(unix, windows)))]
fn release() -> Option<String> {
    None
}
