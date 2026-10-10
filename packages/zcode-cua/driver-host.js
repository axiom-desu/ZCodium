/**
 * macOS 嵌入宿主装配：给 ZCode.app 用的 cua-driver 私有 daemon。
 *
 * 闭源 `ZCode Computer Use.app` Helper 的 TCC 角色由 cua-driver 接管：由持有授权的主进程
 * （Electron main）起 `EmbeddedCuaDriverHost`，socket 经 `ZCODE_CUA_DRIVER_SOCKET` 注入给
 * node_repl host（`CuaDriver.connect`）。见 `computer-use-architecture.md` §3、§4。
 *
 * 本模块是纯装配：不改环境、不起进程，除非显式调用 `start()`。
 */

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

const DEFAULT_HOST_BUNDLE_ID = "dev.zcode";

/**
 * 解析 cua-driver 可执行文件。
 *
 * 优先打包资源目录（必须在 app.asar 之外，且保留可执行位）；其次显式 env；最后 PATH。
 * 找不到返回 undefined，调用方保持 fail-closed。
 */
export function resolveCuaDriverBinaryPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.existsSync ?? existsSync;
  const pathImpl = platform === "win32" ? win32 : posix;
  const candidates = [];
  const resourcesPath = options.resourcesPath;
  if (
    platform === "darwin" &&
    options.isPackaged === true &&
    typeof resourcesPath === "string" &&
    resourcesPath.trim()
  ) {
    candidates.push(pathImpl.join(resourcesPath.trim(), "cua-driver", "cua-driver"));
  }
  const configured = env?.ZCODE_CUA_DRIVER_BIN?.trim();
  if (configured) candidates.push(configured);
  const executable = platform === "win32" ? "cua-driver.exe" : "cua-driver";
  const pathSeparator = platform === "win32" ? ";" : ":";
  for (const dir of (env?.PATH ?? "").split(pathSeparator)) {
    const trimmed = dir.trim();
    if (trimmed) candidates.push(pathImpl.join(trimmed, executable));
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 起 `EmbeddedCuaDriverHost`。没有二进制或 SDK 时返回 undefined（fail-closed），不抛。
 *
 * `environment` 只接受 cua-driver 的固定安全白名单（DISPLAY / WAYLAND_DISPLAY / XDG_* 等）；
 * 传白名单外的键会 `EmbeddedDriverError.Configuration`。macOS 上通常无需额外环境变量。
 */
export async function createEmbeddedCuaDriverHost(options = {}) {
  const binaryPath = options.binaryPath ?? resolveCuaDriverBinaryPath(options);
  if (!binaryPath) return undefined;
  const sdk = options.driverModule ?? (await import("@trycua/cua-driver"));
  const EmbeddedHost = sdk?.EmbeddedCuaDriverHost;
  if (typeof EmbeddedHost !== "function") return undefined;
  const host = new EmbeddedHost(binaryPath, options.hostBundleId ?? DEFAULT_HOST_BUNDLE_ID);
  return {
    binaryPath,
    start(signal) {
      return signal ? host.start({ signal }) : host.start();
    },
    stop() {
      return host.stop();
    },
    restart(signal) {
      return signal ? host.restart({ signal }) : host.restart();
    },
    connection() {
      return host.connection();
    },
    state() {
      return host.state();
    },
    waitForExit(generation, signal) {
      return signal ? host.waitForExit(generation, { signal }) : host.waitForExit(generation);
    },
    dispose() {
      host.uniffiDestroy?.();
    },
  };
}
