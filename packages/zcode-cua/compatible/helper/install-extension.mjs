#!/usr/bin/env node
/**
 * 安装老 GNOME（Shell 42–44）的 WinRects Shell 扩展（`org.cua.WinRects`）。
 *
 * 契约见 `.agents/specs/computer-use-wayland-input.md` §3。
 * GNOME 45+ 使用 cua-driver 官方 `winrects@cua`，这里跳过。
 *
 * 用法：`node compatible/helper/install-extension.mjs`
 * 首次安装需要登录/登出一次，GNOME Shell 才会加载扩展。
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = "cua-winrects@local";
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "gnome-extension");
const target = join(homedir(), ".local", "share", "gnome-shell", "extensions", UUID);

function shellMajorVersion() {
  try {
    const out = execFileSync("gnome-shell", ["--version"], { encoding: "utf8" });
    return Number.parseInt(out.trim().split(/\s+/).pop(), 10);
  } catch {
    return undefined;
  }
}

function extensionState() {
  try {
    const out = execFileSync("gnome-extensions", ["info", UUID], { encoding: "utf8" });
    return /State:\s*(\w+)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

function winRectsReachable() {
  try {
    execFileSync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.cua.WinRects",
        "--object-path",
        "/org/cua/WinRects",
        "--method",
        "org.cua.WinRects.GetVersion",
      ],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

const major = shellMajorVersion();
if (Number.isFinite(major) && major >= 45) {
  console.log(`GNOME Shell ${major} ≥ 45：使用 cua-driver 官方 winrects@cua，跳过 ${UUID}。`);
  process.exit(0);
}

if (!existsSync(join(source, "extension.js"))) {
  console.error(`扩展源不存在：${source}`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`已安装扩展 → ${target}`);

try {
  execFileSync("gnome-extensions", ["enable", UUID], { stdio: "ignore" });
} catch {
  // 未启用也可继续：下面统一按可达性给出引导。
}

// 就绪判定：只有 org.cua.WinRects 在当前会话可应答，compat 才能工作。
// Wayland 下 GNOME Shell 无法热重载，新装/改动的扩展必须登录/登出一次才生效。
if (winRectsReachable()) {
  console.log(`已就绪：org.cua.WinRects 可达（State: ${extensionState() ?? "?"}）。`);
} else {
  console.log(
    `扩展已安装（State: ${extensionState() ?? "?"}），但当前会话还未加载 org.cua.WinRects。`,
  );
  console.log("→ 请注销并重新登录一次（Wayland 下无法热重载 GNOME Shell）。");
}
