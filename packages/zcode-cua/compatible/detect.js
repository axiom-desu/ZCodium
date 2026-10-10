/**
 * 兼容层判定：是否对当前会话启用老 GNOME 的 mutter + WinRects 后端。
 *
 * 契约见 `.agents/specs/computer-use-wayland-input.md` §8.2：
 *   适用 ⇔ Linux ∧ Wayland ∧ GNOME
 *          ∧（GNOME Shell < 45 ∨ portal RemoteDesktop version < 2）
 *          ∧ WinRects 可达
 * 纯函数：所有探测值由调用方注入，便于单测；不在此处发起 D-Bus/进程调用。
 */

function sessionType(env) {
  if (env.XDG_SESSION_TYPE) return env.XDG_SESSION_TYPE;
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "unknown";
}

function toVersion(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function reject(reason, details) {
  return { applies: false, reason, details };
}

export function detectWaylandCompat({
  platform = process.platform,
  env = process.env,
  gnomeShellVersion,
  portalRemoteDesktopVersion,
  winRectsVersion,
} = {}) {
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}${env.XDG_SESSION_DESKTOP ?? ""}`;
  const details = {
    platform,
    session: sessionType(env),
    desktop,
    gnomeShellVersion: toVersion(gnomeShellVersion),
    portalRemoteDesktopVersion: toVersion(portalRemoteDesktopVersion),
    winRectsVersion: toVersion(winRectsVersion),
  };

  if (platform !== "linux") return reject("compat layer only targets Linux", details);
  if (details.session !== "wayland") return reject("compat layer only applies to Wayland", details);
  if (!/gnome/i.test(desktop)) return reject("compat layer only applies to GNOME", details);

  const legacyShell = details.gnomeShellVersion !== undefined && details.gnomeShellVersion < 45;
  const legacyPortal =
    details.portalRemoteDesktopVersion !== undefined && details.portalRemoteDesktopVersion < 2;
  if (!legacyShell && !legacyPortal) {
    return reject("native cua-driver input is available", details);
  }
  if (details.winRectsVersion === undefined) {
    return reject("WinRects extension (org.cua.WinRects) is not reachable", details);
  }
  return {
    applies: true,
    reason: "legacy GNOME Wayland: portal has no libei, using mutter + WinRects",
    details,
  };
}

const WLR_COMPOSITORS = /sway|labwc|wayfire|river|wlroots/i;
const HYPRLAND = /hyprland/i;
const KDE = /kde|plasma/i;

/**
 * 全平台执行路径判定（计划见 `.agents/specs/computer-use-platform-architecture.md` §4、§5）。
 *
 * - Windows / macOS / Linux X11 / wlroots / Hyprland → `native`（cua-driver）；
 * - 老 GNOME Wayland → `compat`（mutter + WinRects）；
 * - KWin（KDE Plasma）→ `unavailable`（上游缺 target-addressable 适配器）。
 *
 * 纯函数：探测值由调用方注入，不发起 D-Bus/进程调用。
 */
export function resolvePlatformPath({
  platform = process.platform,
  env = process.env,
  gnomeShellVersion,
  portalRemoteDesktopVersion,
  winRectsVersion,
} = {}) {
  const session = sessionType(env);
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}${env.XDG_SESSION_DESKTOP ?? ""}`;
  const base = { platform, session, desktop };

  if (platform === "darwin")
    return { ...base, path: "native", reason: "cua-driver native (macOS)" };
  if (platform === "win32")
    return { ...base, path: "native", reason: "cua-driver native (Windows)" };
  if (platform !== "linux") return { ...base, path: "native", reason: "cua-driver native" };
  if (session !== "wayland")
    return { ...base, path: "native", reason: "X11 native (XSendEvent/XTest)" };

  if (/gnome/i.test(desktop)) {
    const compat = detectWaylandCompat({
      platform,
      env,
      gnomeShellVersion,
      portalRemoteDesktopVersion,
      winRectsVersion,
    });
    if (compat.applies) return { ...base, path: "compat", reason: compat.reason };
    if (/WinRects/.test(compat.reason))
      return { ...base, path: "unavailable", reason: compat.reason };
    return { ...base, path: "native", reason: "GNOME native (portal/libei or winrects@cua)" };
  }
  if (KDE.test(desktop)) {
    return {
      ...base,
      path: "unavailable",
      reason: "KWin target-addressable adapter is not provided upstream",
    };
  }
  if (WLR_COMPOSITORS.test(desktop) || HYPRLAND.test(desktop)) {
    return {
      ...base,
      path: "native",
      reason: "wlroots/Hyprland native (virtual-pointer/keyboard)",
    };
  }
  return { ...base, path: "native", reason: "cua-driver native (probe)" };
}
