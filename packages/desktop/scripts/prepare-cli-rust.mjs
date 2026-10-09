#!/usr/bin/env node
// 为桌面 Preview（ZCodium Rust）口味构建并随包分发 Rust CLI runtime。
//
// 背景：.agents/specs/cli-rust-runtime.md 的 M0 之后，Rust runtime 还只能从
// apps/zcode-cli-rust/target 手工取用。Preview 口味是滚动更新模型里 preview 渠道的
// 产品名（见 packages/desktop/scripts/desktop-product-identity.mjs 的身份注释），
// 本来就承担提前通道的验证职责，所以把 Rust binary 的构建与随包分发接在这里，
// 生产口味不受影响。
//
// 落点：bundled-agents/<platform-key>/rust/，由 electron-builder 的 extraResources
// 拷进 resources/rust，主进程按 process.resourcesPath 解析。
// 与 glm/ 的 JS bundle 平级但分开目录：两套 runtime 的启停与回退必须互不影响。

import process from "node:process";
import { chmodSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const rustManifest = resolve(repoRoot, "apps/zcode-cli-rust/Cargo.toml");

/** os-arch → Rust target triple。与 apps/zcode-cli-rust 支持的平台集合一致。 */
const TARGET_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const BINARY_NAME_BASE = "zcode-cli-rust";

function resolveBinaryName(targetOs) {
  return targetOs === "win32" ? `${BINARY_NAME_BASE}.exe` : BINARY_NAME_BASE;
}

function main() {
  const target = getTargetPlatform();
  const triple = TARGET_TRIPLES[target.key];
  if (!triple) {
    throw new Error(`[prepare:cli-rust] 不支持的平台 ${target.key}，无法确定 Rust target triple`);
  }

  console.log(`[prepare:cli-rust] target=${target.key} triple=${triple}`);
  runCommand(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      rustManifest,
      "--bin",
      BINARY_NAME_BASE,
      "--target",
      triple,
    ],
    { cwd: repoRoot, env: process.env },
  );

  const builtBinary = resolve(
    repoRoot,
    "apps/zcode-cli-rust/target",
    triple,
    "release",
    resolveBinaryName(target.os),
  );
  if (!existsSync(builtBinary)) {
    throw new Error(`[prepare:cli-rust] 构建报告成功但找不到产物：${builtBinary}`);
  }

  const stageDir = resolve(desktopRoot, "bundled-agents", target.key, "rust");
  const stagedBinary = resolve(stageDir, resolveBinaryName(target.os));
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  copyFileSync(builtBinary, stagedBinary);
  if (target.os !== "win32") {
    // copyFileSync 不保留源文件的执行位；Windows 不需要，其余平台必须补，
    // 否则 app 侧 spawn 会 EACCES。
    chmodSync(stagedBinary, 0o755);
  }
  console.log(`[prepare:cli-rust] staged ${stagedBinary}`);
}

main();
