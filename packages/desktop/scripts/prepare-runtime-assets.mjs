#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";
import { isPreviewIdentityRequested } from "./desktop-product-identity.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Windows Chrome 导入入口未启用，默认构建继续编译 helper 会增加 CI 时间和发布签名面。
// 保留显式开关，后续恢复入口时仍可复用既有原生实现和供应链校验。
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// CUA 权限浮窗的吸附数据源。仅 macOS；缺 swiftc 时脚本内部自行降级为跳过（浮窗 fail-open
// 到屏幕底部，仍可用），所以无条件挂在 darwin 上不会让构建变脆。
const shouldPrepareMacosWindowBounds = target.os === "darwin";
// Rust CLI runtime 只在 Preview（ZCodium Rust）口味随包分发：生产口味继续只带 glm/ 的 JS bundle。
// 见 packages/desktop/scripts/desktop-product-identity.mjs 的身份注释与
// .agents/specs/cli-rust-runtime.md 的 D4（默认 runtime 仍为 TS，可回退）。
const shouldPrepareCliRust = isPreviewIdentityRequested();

// 本机桌面包内置 agent 的 JS bundle（prepare:agent-bundle），运行时由 app 的 Electron Node runtime 执行。
// Linux x64 远端资源由 prepare:remote-assets 生成，两种桌面包消费同一份归档。
// native-search 归档随仓库分发，准备步骤只做本地解包校验，不需要任何下载源配置。
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(shouldPrepareCliRust ? ["prepare:cli-rust"] : []),
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

// 版本串必须在任何消费方读取前落盘。prepare:remote-assets 会把 appVersion 烧进
// bundled-remote-assets 的 manifest，而 electron-builder 的 beforePack/afterPack 用
// context.packager.appInfo.version 校验同一份 manifest；两侧都经 getBuildMetadata()
// 读同一份 build-meta.json。若此处不先刷新，烘焙读到的是上一次构建留下的旧缓存，
// 新增 commit 后校验必然以 Bundled remote appVersion mismatch 失败。
runTimedPnpmScript("prepare:build-meta");

const shouldSkipRemoteAssets = process.env.ZCODE_SKIP_REMOTE_ASSETS === "1";

if (!shouldSkipRemoteAssets) {
  runTimedPnpmScript("prepare:remote-assets");
} else {
  // CI 已下载独立 Linux producer 的制品，不在两个桌面 job 中重复构建。
  // electron-builder 的 beforePack/afterPack 仍会校验完整随包清单，skip 不能绕过资源检查。
  console.log("[prepare:runtime-assets] skip prepare:remote-assets (ZCODE_SKIP_REMOTE_ASSETS=1)");
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
