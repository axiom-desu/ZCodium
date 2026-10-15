// M8 桌面 E2E 的隔离运行环境。
//
// 目标：每次运行拿到独立的 HOME / userData / sessionData / XDG / 数据根 / 存储库，
// 只透传 GUI 启动必需的白名单变量，绝不继承用户真实 provider key、代理或 ZCODE_* 凭据。
// 临时 HOME 与数据根为空，legacy 数据根迁移天然无 legacy 可搬（见 .agents/specs/cli-rust-m8-e2e.md）。
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** GUI/构建启动必需、且不含用户业务凭据的基础变量。 */
const BASE_ENV_PASSTHROUGH = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY",
  "SYSTEMROOT",
  "WINDIR",
];

export function createE2ERunId() {
  return `m8-${randomUUID()}`;
}

function pickBaseEnv(source, extraPassthrough = []) {
  const env = {};
  for (const key of [...BASE_ENV_PASSTHROUGH, ...extraPassthrough]) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

/**
 * 基于 fixture 的 provider env 补齐桌面隔离变量。
 *
 * `prepareHome` 已经给出 HOME/USERPROFILE/XDG_CONFIG_HOME/ZCODE_STORAGE_DIR/
 * ZCODE_SESSION_DB_PATH 与两个 provider registry 文件；这里只补桌面专属路径与 runtime 选择，
 * 不改写 fixture 的库路径，保证 TS 与 Rust 共用同一份存储。
 */
export async function createDesktopE2EEnvironment({
  sourceEnv = process.env,
  runId = createE2ERunId(),
  fixtureEnv,
  runtime = "zcode-cli-rust",
  dataRoot,
} = {}) {
  if (!fixtureEnv)
    throw new Error("createDesktopE2EEnvironment requires fixtureEnv from prepareHome");
  const root = dataRoot ?? join(tmpdir(), `zcode-m8-desktop-${runId}`);
  const dirs = {
    root,
    home: join(root, "home"),
    userData: join(root, "user-data"),
    sessionData: join(root, "session-data"),
    dataBase: join(root, "data-base"),
    xdgConfig: join(root, "xdg-config"),
    xdgData: join(root, "xdg-data"),
    xdgCache: join(root, "xdg-cache"),
    xdgState: join(root, "xdg-state"),
    artifacts: join(root, "artifacts"),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));

  const env = {
    ...pickBaseEnv(sourceEnv),
    ...fixtureEnv,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_CACHE_HOME: dirs.xdgCache,
    XDG_STATE_HOME: dirs.xdgState,
    ZCODE_DATA_BASE_DIR: dirs.dataBase,
    ZCODE_DESKTOP_HOME_DIR: dirs.home,
    ZCODE_DESKTOP_USER_DATA_DIR: dirs.userData,
    ZCODE_DESKTOP_SESSION_DATA_DIR: dirs.sessionData,
    // 唯一应用名避免命中用户已有 App 的 Electron 单实例锁。
    ZCODE_DESKTOP_APPLICATION_NAME: `ZCodium M8 E2E ${runId}`,
    ZCODE_E2E_RUN_ID: runId,
    ZCODE_E2E_ARTIFACT_DIR: dirs.artifacts,
    // Build-time store bridge 在 renderer 里以 import.meta.env 固化；运行时再给一份，
    // 保证 main/preload 的 shouldEnableE2ETestBridge 双条件成立。
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    ZCODE_AGENT_SERVER_RUNTIME: runtime,
    // 显式关掉真实更新/遥测依赖的隐藏入口，所有出网走 fail-closed 代理。
    ZCODIUM_UPDATE_ORIGIN: "",
    ZCODE_DYNAMIC_WORKFLOW_MODE: "off",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return { runId, ...dirs, env };
}

/** 返回本链路显式声明以外的 ZCODE_* / 凭据变量，用于自检“没有继承真实凭据”。 */
export function auditEnvironmentLeaks(env) {
  const allowed = new Set([
    "ZCODE_DATA_BASE_DIR",
    "ZCODE_DESKTOP_HOME_DIR",
    "ZCODE_DESKTOP_USER_DATA_DIR",
    "ZCODE_DESKTOP_SESSION_DATA_DIR",
    "ZCODE_DESKTOP_APPLICATION_NAME",
    "ZCODE_E2E_RUN_ID",
    "ZCODE_E2E_ARTIFACT_DIR",
    "ZCODE_AGENT_SERVER_RUNTIME",
    "ZCODE_DYNAMIC_WORKFLOW_MODE",
    "ZCODE_STORAGE_DIR",
    "ZCODE_SESSION_DB_PATH",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_HTTP_PROXY",
    "ZCODE_NO_PROXY",
    "ZCODE_RUNTIME_ENV",
    "ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS",
  ]);
  const sensitivePattern = /(token|secret|password|passwd|api[_-]?key|credential|cookie)/i;
  const leaks = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith("ZCODE_")) continue;
    if (allowed.has(key)) continue;
    if (key.startsWith("ZCODE_E2E_")) continue;
    leaks.push(key);
  }
  for (const key of Object.keys(env)) {
    if (sensitivePattern.test(key)) leaks.push(key);
  }
  return [...new Set(leaks)];
}

/** 供诊断输出使用：只暴露路径，不暴露 provider key。 */
export function summarizeEnvironment(env) {
  return {
    runtime: env.ZCODE_AGENT_SERVER_RUNTIME,
    dataBaseDir: env.ZCODE_DATA_BASE_DIR,
    storageDir: env.ZCODE_STORAGE_DIR,
    sessionDbPath: env.ZCODE_SESSION_DB_PATH,
    runId: env.ZCODE_E2E_RUN_ID,
    leaks: auditEnvironmentLeaks(env),
  };
}

export function resolveRepoRoot(fromUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(fromUrl)), "..", "..");
}
