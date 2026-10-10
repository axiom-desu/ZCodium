/**
 * CUA Helper 传输层：闭源 Helper 拆除后**仅存**的一块。
 *
 * 背景：`ZCode Computer Use.app`（macOS）的整条 broker 从未真正进入本仓库 ——
 * `broker-server.js` 一直是 stub（全返回 "Computer Use is not available in this build."），
 * 51 个文件的实现在闭源侧。现在 macOS 路径已改走 cua-driver（见 ./permissions.js、./runtime.js），
 * 这套 broker stub 整体删除。
 *
 * 留下来的只有 **Windows 自研 Helper host 仍在用**的东西：
 *   - broker socket 的铸造 / 解析（agent env 注入）；
 *   - Helper 启动 rendezvous 与健康探针的形状；
 *   - 两个跨进程序列化契约常量；
 *   - Helper host 的传输类型（Windows host 与 services 共用）。
 *
 * 注意：`markCuaProductHelperAgentEnvUnavailable` 一族已随之删除 —— 它们原是 no-op stub，
 * `has...` 恒为 false，删除后 `buildCuaProductHelperAgentEnv` 行为完全不变（少几支死分支）。
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
/** Windows Helper 的 native addon 路径经此 env 传给子进程。 */
export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
/** Windows dev 控制通道的协议标识。 */
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

export function mintBrokerSocketPath(options = {}) {
  const dir = typeof options.dir === "string" && options.dir.trim() ? options.dir : tmpdir();
  return join(dir, `zcode-cua-broker-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return mintBrokerSocketPath(options);
}

/**
 * 等 Helper 启动 Promise，带 caller 侧 deadline。
 * 超时抛 `caller_timeout`（调用方据此判断"后台仍在跑"，不额外退避）。
 */
export async function waitForCuaHelperStartup(startup, deadlineMs) {
  if (!Number.isFinite(deadlineMs)) return await startup;
  let timer;
  try {
    return await Promise.race([
      startup,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CuaHelperError("CUA Helper startup is still running", { code: "caller_timeout" }),
            ),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Helper 健康探针。拿不到真实 Helper 时返回空身份，调用方据此判不可用。 */
export async function probeHelperHealth(_socketPath, _options = {}) {
  return { bundleId: null, pid: null };
}

/** 判定一个 MCP server 条目是否可能是 ZCode CUA 的 agent 侧 server。 */
export function isPotentialZCodeCuaAgentMcpServer(_server) {
  return false;
}
/**
 * Helper 生命周期协调：acquire / peek / dispose + 代际 fence。
 * dispose 只应来自显式的 workspace 生命周期， Helper 不是 Agent runtime owner。
 */
export class CuaHelperLifecycleManager {
  #dispose;
  #current;
  #disposed = false;
  constructor(dispose) {
    this.#dispose = dispose;
    this.#current = undefined;
  }
  async acquire(options) {
    if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) {
      return undefined;
    }
    const managed = options?.create?.();
    this.#current = managed;
    return managed;
  }
  peek() {
    return this.#current;
  }
  get disposed() {
    return this.#disposed;
  }
  async dispose(managed) {
    this.#disposed = true;
    await this.#dispose?.(managed ?? this.#current);
  }
}

/** workspace → Helper enablement 登记。当前为 no-op（admission 由调用方门控）。 */
export class CuaProductHelperWorkspaceRegistry {
  setEnabled(_context, _enabled) {}
}

/** 官方插件 workspace enablement 判定。 */
export function isOfficialCuaPluginEnabledForWorkspace(_options) {
  return false;
}

/**
 * 绑定具体 host 的 MCP server resolver。resolveMcpServers 是 pass-through；
 * restart / restartAfterPermissionGrant 在 Helper 不可用时 fail-closed。
 */
export function createCuaProductMcpServerResolver(_host, _options) {
  return {
    async resolveMcpServers(servers, _context) {
      return servers;
    },
    async restart() {
      throw new CuaHelperError("Computer Use is not available in this build.");
    },
    async restartAfterPermissionGrant(_onboardingSessionId) {
      throw new CuaHelperError("Computer Use is not available in this build.");
    },
  };
}
