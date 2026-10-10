/**
 * `compatible/detect.js` 单测。
 *
 * 覆盖 `.agents/specs/computer-use-wayland-input.md` §8.2 的判定：
 * 只有 Linux + Wayland + GNOME 且（老 Shell ∨ 老 portal）且 WinRects 可达才启用。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { detectWaylandCompat, resolvePlatformPath } from "../compatible/detect.js";

const WAYLAND_GNOME = { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" };

test("非 Linux 不启用", () => {
  const result = detectWaylandCompat({ platform: "darwin", env: WAYLAND_GNOME });
  assert.equal(result.applies, false);
  assert.match(result.reason, /Linux/);
});

test("Linux 但 X11 不启用", () => {
  const result = detectWaylandCompat({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
  });
  assert.equal(result.applies, false);
  assert.match(result.reason, /Wayland/);
});

test("非 GNOME（KDE）不启用", () => {
  const result = detectWaylandCompat({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" },
  });
  assert.equal(result.applies, false);
  assert.match(result.reason, /GNOME/);
});

test("GNOME 46 + portal v2：走原生，不启用兼容层", () => {
  const result = detectWaylandCompat({
    platform: "linux",
    env: WAYLAND_GNOME,
    gnomeShellVersion: "46",
    portalRemoteDesktopVersion: "2",
    winRectsVersion: "8",
  });
  assert.equal(result.applies, false);
  assert.match(result.reason, /native/);
});

test("老 GNOME 42 + portal v1 + WinRects：启用", () => {
  const result = detectWaylandCompat({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
    gnomeShellVersion: "42.9",
    portalRemoteDesktopVersion: "1",
    winRectsVersion: "8",
  });
  assert.equal(result.applies, true);
  assert.equal(result.details.gnomeShellVersion, 42);
  assert.equal(result.details.portalRemoteDesktopVersion, 1);
});

test("新 Shell 但老 portal（无 libei）也启用", () => {
  const result = detectWaylandCompat({
    platform: "linux",
    env: WAYLAND_GNOME,
    gnomeShellVersion: "46",
    portalRemoteDesktopVersion: "1",
    winRectsVersion: "8",
  });
  assert.equal(result.applies, true);
});

test("老 GNOME 但 WinRects 不可达：不启用且给出原因", () => {
  const result = detectWaylandCompat({
    platform: "linux",
    env: WAYLAND_GNOME,
    gnomeShellVersion: "42",
    portalRemoteDesktopVersion: "1",
  });
  assert.equal(result.applies, false);
  assert.match(result.reason, /WinRects/);
});

test("portal 无 XDG_SESSION_TYPE 时按 WAYLAND_DISPLAY 判定", () => {
  const result = detectWaylandCompat({
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "GNOME" },
    gnomeShellVersion: "42",
    portalRemoteDesktopVersion: "1",
    winRectsVersion: "8",
  });
  assert.equal(result.applies, true);
  assert.equal(result.details.session, "wayland");
});

test("resolvePlatformPath：Windows / macOS / X11 走 native", () => {
  assert.equal(resolvePlatformPath({ platform: "darwin" }).path, "native");
  assert.equal(resolvePlatformPath({ platform: "win32" }).path, "native");
  assert.equal(
    resolvePlatformPath({ platform: "linux", env: { XDG_SESSION_TYPE: "x11" } }).path,
    "native",
  );
});

test("resolvePlatformPath：老 GNOME → compat，新 GNOME → native", () => {
  assert.equal(
    resolvePlatformPath({
      platform: "linux",
      env: WAYLAND_GNOME,
      gnomeShellVersion: "42",
      portalRemoteDesktopVersion: "1",
      winRectsVersion: "8",
    }).path,
    "compat",
  );
  assert.equal(
    resolvePlatformPath({
      platform: "linux",
      env: WAYLAND_GNOME,
      gnomeShellVersion: "46",
      portalRemoteDesktopVersion: "2",
      winRectsVersion: "8",
    }).path,
    "native",
  );
  assert.equal(
    resolvePlatformPath({
      platform: "linux",
      env: WAYLAND_GNOME,
      gnomeShellVersion: "42",
      portalRemoteDesktopVersion: "1",
    }).path,
    "unavailable",
  );
});

test("resolvePlatformPath：wlroots/Hyprland native，KWin 缺口", () => {
  const wl = { XDG_SESSION_TYPE: "wayland" };
  assert.equal(
    resolvePlatformPath({ platform: "linux", env: { ...wl, XDG_CURRENT_DESKTOP: "sway" } }).path,
    "native",
  );
  assert.equal(
    resolvePlatformPath({ platform: "linux", env: { ...wl, XDG_CURRENT_DESKTOP: "Hyprland" } })
      .path,
    "native",
  );
  assert.equal(
    resolvePlatformPath({ platform: "linux", env: { ...wl, XDG_CURRENT_DESKTOP: "KDE" } }).path,
    "unavailable",
  );
});
