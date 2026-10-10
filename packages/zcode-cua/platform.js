/**
 * 平台运行时装配：把平台判定结果变成 `createComputerUseRuntime` 的选项。
 *
 * 契约见 `.agents/specs/computer-use-platform-architecture.md` §4、§6。
 *
 * - Linux：老 GNOME → 组装 compat（helper + backend + executor）；其余走 cua-driver 原生。
 * - macOS：走 cua-driver 原生；TCC（辅助功能 + 屏幕录制）由嵌入宿主 ZCode.app 持有，
 *   这里只报告 `requiresMacOsPermissions`，不做授权。
 * - Windows：与 macOS 同为 native；具体嵌入由另一路负责。
 *
 * client（cua-driver SDK / daemon connect）由宿主注入；缺失时保持 fail-closed。
 */

import { execFileSync } from "node:child_process";

import { createWaylandInputBackend } from "./compatible/backend.js";
import { createCompatExecutor } from "./compatible/executor.js";
import { createHelperClient } from "./compatible/helper-client.js";
import { resolvePlatformPath } from "./compatible/detect.js";
import { createCuaDriverPermissionService } from "./permissions.js";
import { createComputerUseRuntime, createUnavailableRuntime } from "./runtime.js";

/**
 * 同步探测 GNOME 兼容层判定所需的版本（best-effort，失败留 undefined）。
 * 仅 Linux 调用；不要求 root，只用 `gnome-shell --version` 与 `gdbus`。
 */
export function probeGnomeEnvironment() {
  const probes = {};
  try {
    const out = execFileSync("gnome-shell", ["--version"], { encoding: "utf8" });
    probes.gnomeShellVersion = out.trim().split(/\s+/).pop();
  } catch {
    // 忽略：无 gnome-shell 或不可执行。
  }
  const property = (dest, iface) => {
    try {
      const out = execFileSync(
        "gdbus",
        [
          "call",
          "--session",
          "--dest",
          dest,
          "--object-path",
          "/org/freedesktop/portal/desktop",
          "--method",
          "org.freedesktop.DBus.Properties.Get",
          iface,
          "version",
        ],
        { encoding: "utf8" },
      );
      return /uint32 (\d+)/.exec(out)?.[1];
    } catch {
      return undefined;
    }
  };
  probes.portalRemoteDesktopVersion = property(
    "org.freedesktop.portal.Desktop",
    "org.freedesktop.portal.RemoteDesktop",
  );
  try {
    const out = execFileSync(
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
      { encoding: "utf8" },
    );
    probes.winRectsVersion = /uint32 (\d+)/.exec(out)?.[1];
  } catch {
    // 忽略：扩展未安装。
  }
  return probes;
}

/**
 * 老 GNOME compat 的就绪判定：`org.cua.WinRects` 可达才可用；
 * 不可达时给出“安装扩展 + 登录/登出一次”的引导（Wayland 无法热重载 Shell）。
 */
export function describeCompatReadiness(probes = {}) {
  const shell = Number.parseInt(String(probes.gnomeShellVersion ?? ""), 10);
  const portal = Number.parseInt(String(probes.portalRemoteDesktopVersion ?? ""), 10);
  const legacy = (Number.isFinite(shell) && shell < 45) || (Number.isFinite(portal) && portal < 2);
  if (!legacy) {
    return { ready: true, needsExtension: false, reason: "native path (compat not required)" };
  }
  const reachable =
    probes.winRectsVersion !== undefined &&
    probes.winRectsVersion !== null &&
    String(probes.winRectsVersion).trim() !== "";
  if (reachable) {
    return {
      ready: true,
      needsExtension: false,
      reason: "compat ready (org.cua.WinRects reachable)",
    };
  }
  return {
    ready: false,
    needsExtension: true,
    reason: "legacy GNOME needs the WinRects extension loaded",
    guidance: "运行 pnpm --filter @zcode/zcode-cua install:gnome-extension 后注销并重新登录一次",
  };
}

/** Linux 老 GNOME 的 compat 选项（注入 client 以便解析元素框 / set_value）。 */
export function createCompatRuntimeOptions({ client, helper } = {}) {
  const backend = createWaylandInputBackend({ helper: helper ?? createHelperClient() });
  const executor = createCompatExecutor({ backend, client });
  return { applies: true, execute: executor.execute, dispose: executor.dispose };
}

/**
 * Linux Wayland 会话必须显式打开 cua-driver 的 Wayland 窗口后端。
 * 否则 `list_windows` / `get_app_state` 只能枚举 XWayland 窗口，原生 Wayland
 * 应用（如 GNOME Calculator）不可见。X11 会话不设置，避免强制走 Wayland。
 * 该环境变量由 cua-driver 原生库在初始化时读取，故必须在 import SDK 之前生效。
 */
function ensureDriverWindowBackend({ platform, env }) {
  if (platform !== "linux" || !env || env.CUA_DRIVER_RS_ENABLE_WAYLAND) return;
  const wayland = env.XDG_SESSION_TYPE === "wayland" || Boolean(env.WAYLAND_DISPLAY);
  if (wayland) env.CUA_DRIVER_RS_ENABLE_WAYLAND = "1";
}

/**
 * @param {object} options
 * @param {string} [options.platform] `process.platform`
 * @param {object} [options.env] 探测用环境变量
 * @param {object} [options.probes] `{ gnomeShellVersion, portalRemoteDesktopVersion, winRectsVersion }`
 * @param {object} [options.client] 已构造的 cua-driver client
 * @param {string} [options.socketPath] daemon socket（交给 connectDriver）
 * @param {Function} [options.connectDriver] `(socketPath?) => client`（同步构造）
 * @param {object} [options.compat] 覆盖默认 compat 选项（测试用）
 */
export function assembleComputerUseRuntime({
  platform = process.platform,
  env = process.env,
  probes = {},
  client,
  socketPath,
  connectDriver,
  compat,
} = {}) {
  ensureDriverWindowBackend({ platform, env });
  const path = resolvePlatformPath({ platform, env, ...probes });
  const requiresMacOsPermissions = path.path === "native" && platform === "darwin";

  if (path.path === "unavailable") {
    return {
      path,
      runtime: createUnavailableRuntime(path.reason),
      requiresMacOsPermissions: false,
    };
  }

  let driverClient = client;
  if (!driverClient && typeof connectDriver === "function") {
    try {
      driverClient = connectDriver(socketPath);
    } catch {
      driverClient = undefined;
    }
  }
  if (!driverClient) {
    return {
      path,
      runtime: createUnavailableRuntime(
        `Computer Use unavailable: no cua-driver client for ${path.path} path`,
      ),
      requiresMacOsPermissions,
    };
  }

  const compatOptions =
    path.path === "compat"
      ? (compat ?? createCompatRuntimeOptions({ client: driverClient }))
      : undefined;
  return {
    path,
    runtime: createComputerUseRuntime({ client: driverClient, compat: compatOptions }),
    requiresMacOsPermissions,
  };
}

async function loadCuaDriver() {
  try {
    const mod = await import("@trycua/cua-driver");
    return mod?.CuaDriver;
  } catch {
    return undefined;
  }
}

/**
 * 异步装配：自己 `import("@trycua/cua-driver")` 拿 SDK，再交给同步装配。
 * 依赖包的 `exports` 只有 `import` 条件，无法同步 require，所以 host 走这条。
 */
export async function assembleComputerUseRuntimeAsync({
  platform = process.platform,
  env = process.env,
  probes = {},
  socketPath,
  compat,
  driverModule,
} = {}) {
  // 必须在 import 原生 SDK 之前设置（原生库在初始化时读取该变量）。
  ensureDriverWindowBackend({ platform, env });
  const CuaDriver = driverModule ?? (await loadCuaDriver());
  const connectDriver = CuaDriver
    ? (path) =>
        path && typeof CuaDriver.connect === "function"
          ? CuaDriver.connect(path)
          : CuaDriver.create?.(undefined)
    : undefined;
  return assembleComputerUseRuntime({ platform, env, probes, socketPath, compat, connectDriver });
}

/**
 * 异步装配权限服务（`ICuaPermissionService`）。
 *
 * - Linux / dev：同进程 SDK `CuaDriver.create()`（`check_permissions` 直接可用）。
 * - macOS：宿主应传入嵌入宿主的 `socketPath`（`ZCODE_CUA_DRIVER_SOCKET`）走 `connect()`，
 *   TCC 归 ZCode.app，不在这里另起 driver。
 * - 没有 driver 时保持 fail-closed，返回的 `getStatus()` 会给出原因而不是伪造授权。
 */
export async function assembleCuaPermissionServiceAsync({
  platform = process.platform,
  env = process.env,
  socketPath,
  driverModule,
} = {}) {
  ensureDriverWindowBackend({ platform, env });
  const CuaDriver = driverModule ?? (await loadCuaDriver());
  let client;
  if (CuaDriver) {
    try {
      client =
        socketPath && typeof CuaDriver.connect === "function"
          ? CuaDriver.connect(socketPath)
          : CuaDriver.create?.(undefined);
    } catch {
      client = undefined;
    }
  }
  return createCuaDriverPermissionService({ client, platform });
}
