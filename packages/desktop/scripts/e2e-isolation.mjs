/**
 * Electron E2E 入口隔离（Node builtins only）。
 *
 * 为什么单独成文件：`packages/services/src/paths.ts` 在模块 import 时就把
 * `ZCODE_DATA_BASE_DIR` / `HOME` 固化进模块级变量，Electron 主进程里的日志、诊断、
 * 凭据与存储路径都以此为根。ESM 静态 import 先于脚本正文执行，所以只要入口自己
 * import 了业务模块，正文里再设 env 已经来不及——测试会写进开发者真实
 * `~/.zcodium-exp`，或在 Electron 默认 appData 下留下测试退出记录。
 *
 * 因此入口一律走「仅 Node builtins 的薄启动器 → 先建临时目录与 env → 再 spawn runner」。
 * 这里集中维护临时根目录、路径断言与子进程启动，禁止调用方自己拼一套环境变量。
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** 隔离根标记：runner 用它确认自己是被隔离启动器拉起的，而不是直接执行。 */
export const E2E_ISOLATION_ROOT_ENV = "ZCODE_E2E_ISOLATION_ROOT";

/**
 * 必须指向隔离根内部的路径型 env。
 * HOME/XDG/appData 覆盖 Node 与 Electron 的默认目录；ZCODE_* 覆盖产品自身的数据、
 * 会话与桌面 userData；TMP* 让 runner 的 `mkdtemp(tmpdir())` 证据目录也落在隔离根内。
 */
export const E2E_ISOLATION_PATH_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TMP",
  "TEMP",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_STORAGE_DIR",
  "ZCODE_SESSION_DB",
  "ZCODE_DESKTOP_HOME_DIR",
  "ZCODE_DESKTOP_USER_DATA_DIR",
  "ZCODE_DESKTOP_SESSION_DATA_DIR",
];

/** 父进程里存在会改变默认落盘位置的开关，隔离时必须清掉，否则显式 userData 会被忽略。 */
const CLEARED_ENV_KEYS = ["ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA", "ELECTRON_RUN_AS_NODE"];

function comparable(pathValue) {
  const normalized = resolve(pathValue);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 判断 `child` 是否等于或位于 `parent` 之内（不做 IO，纯字符串解析）。 */
export function isPathInside(child, parent) {
  const childPath = comparable(child);
  const parentPath = comparable(parent);
  return (
    childPath === parentPath ||
    childPath.startsWith(parentPath.endsWith(sep) ? parentPath : parentPath + sep)
  );
}

/**
 * 创建一套临时隔离环境。
 *
 * 返回的 `env` 就是必须传给所有 Node/Electron/Agent 子进程的完整环境；
 * 不要只传其中几个键，也不要让子进程再从父进程继承一份。
 */
export async function createE2EIsolation(options = {}) {
  const parentEnv = options.parentEnv ?? process.env;
  const root = await mkdtemp(join(options.baseDir ?? tmpdir(), "zcode-e2e-isolation-"));
  const dirs = {
    home: join(root, "home"),
    xdgConfigHome: join(root, "xdg", "config"),
    xdgDataHome: join(root, "xdg", "data"),
    xdgCacheHome: join(root, "xdg", "cache"),
    xdgStateHome: join(root, "xdg", "state"),
    appData: join(root, "app-data"),
    localAppData: join(root, "local-app-data"),
    dataBaseDir: join(root, "data-base"),
    storageDir: join(root, "storage"),
    sessionDb: join(root, "storage", "session.sqlite"),
    desktopHome: join(root, "desktop-home"),
    userData: join(root, "user-data"),
    sessionData: join(root, "user-data", "session"),
    tmp: join(root, "tmp"),
  };
  // 修复：sessionDb 是文件而非目录；把它 mkdir 后，普通 bootstrap 会以 SQLITE_CANTOPEN 失败。
  await Promise.all(
    Object.entries(dirs)
      .filter(([key]) => key !== "sessionDb")
      .map(([, dir]) => mkdir(dir, { recursive: true })),
  );
  const env = {
    ...parentEnv,
    [E2E_ISOLATION_ROOT_ENV]: root,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.xdgConfigHome,
    XDG_DATA_HOME: dirs.xdgDataHome,
    XDG_CACHE_HOME: dirs.xdgCacheHome,
    XDG_STATE_HOME: dirs.xdgStateHome,
    APPDATA: dirs.appData,
    LOCALAPPDATA: dirs.localAppData,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    // 数据根是「基路径」，产品会在其下再建 .zcodium-exp；存储/会话另给独立子目录，
    // 与桌面 userData 分开，避免 fixture 之间互相读到对方的缓存。
    ZCODE_DATA_BASE_DIR: dirs.dataBaseDir,
    ZCODE_STORAGE_DIR: dirs.storageDir,
    ZCODE_SESSION_DB: dirs.sessionDb,
    ZCODE_DESKTOP_HOME_DIR: dirs.desktopHome,
    ZCODE_DESKTOP_USER_DATA_DIR: dirs.userData,
    ZCODE_DESKTOP_SESSION_DATA_DIR: dirs.sessionData,
  };
  for (const key of CLEARED_ENV_KEYS) delete env[key];
  const resolved = await realpath(root);
  return { root, resolvedRoot: resolved, dirs, env };
}

/**
 * 校验 env 确实指向上面的隔离根。runner 与 runner 的子进程都可调用；
 * 失败直接抛错，避免在真实 HOME 下继续跑。
 */
export function assertIsolatedEnv(env = process.env) {
  const root = env[E2E_ISOLATION_ROOT_ENV];
  if (!root) {
    throw new Error(
      `E2E 必须以隔离启动器运行（缺少 ${E2E_ISOLATION_ROOT_ENV}）；` +
        "直接执行 runner 会把测试数据写进真实 HOME/appData。",
    );
  }
  for (const key of E2E_ISOLATION_PATH_ENV_KEYS) {
    const value = env[key];
    if (!value) throw new Error(`E2E 隔离环境缺少 ${key}`);
    if (!isPathInside(value, root)) {
      throw new Error(`E2E 隔离环境 ${key}=${value} 不在隔离根 ${root} 内`);
    }
  }
  return root;
}

/**
 * 用隔离 env 启动一个 Node 子进程（启动器只用于拉起 runner）。
 * 传整份 env、不改 argv：既有 flag、输出与退出码语义都留在 runner 里。
 */
export function spawnIsolated(args, options = {}) {
  const env = options.env ?? process.env;
  assertIsolatedEnv(env);
  return spawn(process.execPath, args, {
    env,
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
  });
}
