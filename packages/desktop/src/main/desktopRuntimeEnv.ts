/* eslint-disable max-lines -- desktop runtime/env 解析需要集中维护 main/host/remote assets 的启动边界，拆分会扩大远程连接回归面。 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { ConnectOptions } from "@zcode/server/remote";
import { listSSHConfigAliasesFromLocalConfig } from "@zcode/services/node";
import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_APP_VERSION_ENV,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_RUNTIME_ENV_KEY,
  ZCODE_VERSION,
  buildZCodeToolEnvPassthroughEnv,
  normalizeDynamicWorkflowMode,
  pickProductEndpointEnv,
  readProductEndpointEnv,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiBusinessBaseUrl,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
  sanitizeZCodeRuntimeEnv,
  type ZCodeRuntimeEnv,
} from "@zcode/shared";
import { resolvePlatformKeyForPackagedApp } from "../../scripts/target-platform.mjs";
import { desktopProductIdentities } from "../../scripts/desktop-product-identity.mjs";
import {
  getAppConfigDir,
  getDataBaseDir,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "@zcode/services/node";
import { getElectronAppPath, isElectronAppPackaged } from "./desktopElectronApp.js";

const isLocalDevelopmentRuntime = !isElectronAppPackaged();
export const desktopRuntimeEnv: ZCodeRuntimeEnv = isLocalDevelopmentRuntime
  ? "development"
  : "production";
// 身份看编译期 flavor 而不是 ZCODE_ENV：ZCODE_PREVIEW_IDENTITY=1 的生产后端构建同样是 Preview，
// 需要独立的应用名、Electron 数据目录和 Helper 安装子目录才能与正式版并排运行。
const isPreviewPackagedRuntime = !isLocalDevelopmentRuntime && ZCODE_PRODUCT_FLAVOR === "preview";

function readRuntimeEnvOverride(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function isTruthyRuntimeEnvOverride(name: string): boolean {
  const value = readRuntimeEnvOverride(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// e2e 运行的是生产构建，默认会和本机正式版 ZCode 共用 app name / userData，
// 触发 Electron 单实例锁后只激活已有窗口，Chromedriver 无法接管测试进程。
// 这里允许测试显式隔离运行时身份，正常桌面/远控路径保持原来的默认值。
// 应用名取构建期产品身份（desktop-product-identity.mjs），与安装包身份同源：
// 之前这里硬编码 "ZCode"，导致 app 菜单、process.title、Linux desktop 条目的 Name
// 和 Electron 用户数据目录都还是旧名，和包里的身份不一致。现在身份是 `ZCodium Exp`，
// 于是 app 菜单名、进程标题、Linux desktop 条目 Name 与 userData 目录都跟着变成新名；
// userData 的搬迁见下方 LEGACY_RUNTIME_APPLICATION_NAME 处的链式迁移。
export const runtimeApplicationName =
  readRuntimeEnvOverride("ZCODE_DESKTOP_APPLICATION_NAME") ??
  (isLocalDevelopmentRuntime
    ? `${desktopProductIdentities.production.productName} Dev`
    : desktopProductIdentities[isPreviewPackagedRuntime ? "preview" : "production"].productName);
// 改名前的 Electron 用户数据目录名，只用于一次性迁移。
// Bugfix：产品身份从 `ZCodium` 改名为 `ZCodium Exp` 后，runtimeApplicationName 变成
// "ZCodium Exp"，userData 目录随之从 `<appData>/ZCodium` 换到 `<appData>/ZCodium Exp`。
// 若不做迁移，存量用户的登录态、会话与缓存会留在旧目录，表现为升级后要重新登录。
// 于是这里从"单条链"变成"按时间倒序的链"：先搬最近一次改名前的身份，搬不动再试更早的。
// 顺序很重要——若先把 `ZCode` 搬成 `ZCodium Exp`，用户的 `ZCodium` 数据就被跳过而遗留在原地。
const LEGACY_RUNTIME_APPLICATION_NAME = "ZCode";
const RENAMED_FROM_RUNTIME_APPLICATION_NAME = "ZCodium";
// Electron 的 app.getPath("home") 不一定跟随测试进程里的 HOME 覆盖。
// e2e 默认工作区依赖 home 路径，因此提供显式覆盖，避免测试写到开发者真实 ~/ZCodeProject。
export const runtimeHomePath = readRuntimeEnvOverride("ZCODE_DESKTOP_HOME_DIR");
// Chromedriver 管理 Electron 时会注入临时 userData；e2e 默认路径模式下导入期不能提前读取 appData。
export const shouldUseElectronDefaultUserDataPath = isTruthyRuntimeEnvOverride(
  "ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA",
);
export const runtimeUserDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_USER_DATA_DIR") ??
  (shouldUseElectronDefaultUserDataPath
    ? undefined
    : join(getElectronAppPath("appData"), runtimeApplicationName));
export const runtimeSessionDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_SESSION_DATA_DIR") ??
  (runtimeUserDataPath ? join(runtimeUserDataPath, "session") : undefined);

interface RuntimeUserDataMigrationLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * 把改名前的 Electron 用户数据目录整体搬到新身份目录，只搬一次。
 *
 * 运行时应用名从 ZCode 改成 ZCodium 后，userData 会从 ~/config/ZCode 换到 ~/config/ZCodium。
 * 这里在 app.setPath("userData") 之前做 rename，让登录态、会话、缓存跟着一起搬家；
 * 与 `.zcode` → `.zcodium` 数据目录那次「不迁移」不同：那是一次产品级数据换根，
 * 而这是同一份桌面身份数据改名，搬过去用户才不用重新登录。
 *
 * 只在同时满足「新目录不存在、旧目录存在、没有显式 userData 覆盖」时搬迁：
 * 两边都在时保留现状并告警，避免覆盖任何一方的数据。
 */
export function migrateRuntimeUserDataDir(logger: RuntimeUserDataMigrationLogger): void {
  if (
    shouldUseElectronDefaultUserDataPath ||
    readRuntimeEnvOverride("ZCODE_DESKTOP_USER_DATA_DIR")
  ) {
    return;
  }
  const appDataDir = getElectronAppPath("appData");
  const nextPath = join(appDataDir, runtimeApplicationName);
  // 从最近的旧身份开始试：`ZCodium` 优先于更早的 `ZCode`。只搬一次到 nextPath 就停，
  // 避免连锁覆盖——连续换名两次时，用户真正的数据在 `ZCodium` 里，先搬 `ZCode` 会把
  // 更近的那份留在原地。
  for (const legacyName of [
    RENAMED_FROM_RUNTIME_APPLICATION_NAME,
    LEGACY_RUNTIME_APPLICATION_NAME,
  ]) {
    const legacyPath = join(appDataDir, legacyName);
    if (nextPath === legacyPath || !existsSync(legacyPath)) {
      continue;
    }
    if (existsSync(nextPath)) {
      logger.warn("[runtime] 新旧用户数据目录同时存在，跳过迁移", {
        legacyPath,
        nextPath,
      });
      return;
    }
    try {
      renameSync(legacyPath, nextPath);
      logger.info("[runtime] 用户数据目录已迁移到新应用名", { legacyPath, nextPath });
    } catch (error) {
      // 目录被占用或跨设备时 rename 会失败；不能因此阻断启动，应用只在新目录重建，
      // 旧目录原地保留，用户重新登录一次即可。
      logger.warn("[runtime] 用户数据目录迁移失败，保留旧目录", { legacyPath, nextPath, error });
    }
    return;
  }
}
// Chromedriver 会注入临时 --user-data-dir，并在该目录等待 DevToolsActivePort。
// e2e 如果再用 app.setPath 覆盖 userData/sessionData，端口文件会被写到另一个目录，
// 导致 Electron 已启动但 WebDriver session 一直创建失败。测试态打开该开关后保留 Chromedriver 的目录。
export const hostModulePath = join(import.meta.dirname, "../host/index.js");
export const schedulerModulePath = join(import.meta.dirname, "../scheduler/index.js");
export function getCredentialsDir() {
  return getAppConfigDir();
}

export type RemoteAssetDirs = Pick<ConnectOptions, "bundledRemoteAssetsDir">;
type LocalRuntimeEnv = Record<string, string | undefined>;

export async function isDockerDaemonAvailable(): Promise<boolean> {
  const { isDockerAvailable } = await import("@zcode/server/remote");
  return isDockerAvailable();
}

export async function listAvailableWSLDistros() {
  const { listWSLDistros } = await import("@zcode/server/remote");
  return listWSLDistros();
}

export async function listAvailableDockerContainers() {
  const { listDockerContainers } = await import("@zcode/server/remote");
  return listDockerContainers();
}

export async function listSSHConfigAliases() {
  return await listSSHConfigAliasesFromLocalConfig();
}

function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function resolveWorkspaceRootForEnvFiles(): string | null {
  const workspaceRootCandidate = resolve(import.meta.dirname, "../../../..");
  return existsSync(join(workspaceRootCandidate, "pnpm-workspace.yaml"))
    ? workspaceRootCandidate
    : null;
}

export function loadHostProcessEnvFromLocalFiles(): Record<string, string> {
  if (isElectronAppPackaged()) {
    return {};
  }

  const desktopRoot = resolve(import.meta.dirname, "../..");
  const workspaceRoot = resolveWorkspaceRootForEnvFiles();
  const fileCandidates = [
    ...(workspaceRoot
      ? [resolve(workspaceRoot, ".env"), resolve(workspaceRoot, ".env.local")]
      : []),
    // 开发态 host process 不经过 Vite，自行加载相同的 .env 文件以保持 OAuth 配置一致。
    ...(workspaceRoot && isLocalDevelopmentRuntime
      ? [
          resolve(workspaceRoot, ".env.development"),
          resolve(workspaceRoot, ".env.development.local"),
        ]
      : []),
    resolve(desktopRoot, ".env"),
    resolve(desktopRoot, ".env.local"),
    ...(isLocalDevelopmentRuntime
      ? [resolve(desktopRoot, ".env.development"), resolve(desktopRoot, ".env.development.local")]
      : []),
  ];

  const merged: Record<string, string> = {};
  const seen = new Set<string>();

  for (const candidate of fileCandidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (!existsSync(candidate)) {
      continue;
    }

    // 之前按 cwd 向上级目录泛搜 .env，容易误读到工作区外的同名文件。
    // 这里将加载范围收敛为 workspace 根与 desktop 包目录，避免配置来源漂移。
    const parsed = parseDotenv(readFileSync(candidate, "utf-8"));
    Object.assign(merged, parsed);
  }

  return applySelectedZCodeEnvLinks(merged);
}

export function resolveZCodeEndpointEnvBaseOrigin(
  localEnv: LocalRuntimeEnv = {},
): string | undefined {
  const buildEnv = readProductEndpointEnv();
  // main 进程临时验证更新服务时不会重新写 .env，命令行传入的 endpoint 必须优先于本地文件。
  return (
    process.env["ZCODE_BASE_URL"]?.trim() ||
    process.env["ZCODE_ENDPOINT_ORIGIN"]?.trim() ||
    localEnv.ZCODE_BASE_URL?.trim() ||
    localEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    buildEnv.ZCODE_BASE_URL?.trim() ||
    buildEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    undefined
  );
}

function readDefinedProcessEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

function applySelectedZCodeEnvLinks(env: Record<string, string>): Record<string, string> {
  const endpointEnv = {
    ...readProductEndpointEnv(),
    ...env,
    ZCODE_ENV,
  };

  return {
    ...pickProductEndpointEnv(endpointEnv),
    ...env,
    ZCODE_BASE_URL: env.ZCODE_BASE_URL ?? resolveRuntimeZCodeEndpointOrigin(endpointEnv),
    ZAI_OAUTH_ORIGIN: env.ZAI_OAUTH_ORIGIN ?? resolveZaiOAuthOrigin(endpointEnv),
    ZAI_BUSINESS_BASE_URL: env.ZAI_BUSINESS_BASE_URL ?? resolveZaiBusinessBaseUrl(endpointEnv),
    ZAI_OAUTH_CLIENT_ID: env.ZAI_OAUTH_CLIENT_ID ?? resolveZaiOAuthClientId(endpointEnv),
  };
}

function resolveHostProcessNodeEnv(): ZCodeRuntimeEnv {
  return desktopRuntimeEnv;
}

export function resolveRemoteAssetDirs(): RemoteAssetDirs {
  // 开发与发行都读取同一种随包清单；缺失时由部署入口报错，不回退网络或旧 cache。
  return {
    bundledRemoteAssetsDir: isElectronAppPackaged()
      ? join(process.resourcesPath, "remote-assets")
      : join(import.meta.dirname, "../../bundled-remote-assets"),
  };
}

function resolveBundledZCodeAgentBinaryPath(): string | undefined {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const platformKey = resolvePlatformKeyForPackagedApp();
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, runtime.bundledResourceDir, ...entrySegments)
      : null,
    // desktop 开发态的启动 cwd 可能是 packages/desktop，也可能是仓库根，
    // 之前这里只按 import.meta.dirname 的相对路径推导 bundled-agents，
    // 这里补齐和 services 侧一致的多候选根目录，避免开发/构建/重启入口不同导致资源解析漂移。
    join(
      process.cwd(),
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      import.meta.dirname,
      "../../bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledRuntimeToolBinaryPath(
  toolDir: string,
  binaryName: string,
): string | undefined {
  const candidateBinaryName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, "tools", toolDir, candidateBinaryName)
      : null,
    join(
      import.meta.dirname,
      "../../bundled-tools",
      resolvePlatformKeyForPackagedApp(),
      toolDir,
      candidateBinaryName,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledLarkCliBinaryPath(): string | undefined {
  return resolveBundledRuntimeToolBinaryPath("lark-cli", "lark-cli");
}

export function resolveBundledGlmBinaryPath(): string | undefined {
  return resolveBundledZCodeAgentBinaryPath();
}

function resolveHostProcessBinaryEnv(
  envVar: string,
  hostProcessLocalEnv: Record<string, string>,
  bundledPath: string | undefined,
): string | undefined {
  // ZCode Agent 与 app 协议适配强绑定版本，生产包必须优先使用随包携带的固定 runtime。
  // 用户机器或本地 .env 里残留的 GLM_BINARY_PATH 即使存在，也可能版本不兼容。
  // 只有 bundled runtime 缺失时才把显式路径作为兜底，避免用户本机 CLI 覆盖内嵌版本。
  if (bundledPath) {
    return bundledPath;
  }
  const explicitPath = process.env[envVar]?.trim() || hostProcessLocalEnv[envVar]?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }
  return undefined;
}

function resolveWindowsAppInstallDirForDataBaseDirGuard(
  options: {
    platform?: NodeJS.Platform | string;
    isPackaged?: boolean;
    resourcesPath?: string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const packaged = options.isPackaged ?? isElectronAppPackaged();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (platform !== "win32" || !packaged) {
    return undefined;
  }

  const trimmedResourcesPath = resourcesPath?.trim();
  if (!trimmedResourcesPath) {
    return undefined;
  }

  return win32.dirname(trimmedResourcesPath);
}

/**
 * Dynamic Workflow 灰度的本地覆盖按构建档位分三层
 *
 *   - 未打包 dev：透传 shell 里的合法取值，方便手工切档；非法值直接丢弃而不是转发给 Host，
 *     Host 因此不必再判一次来源；
 *   - 打包 preview：固定写入 `alwaysOn`，忽略 shell，preview 用户始终拥有该功能；
 *   - 打包 production：不写入，且继承值必须被删除，否则本机环境变量就能自行打开灰度。
 * Main 是唯一决策者：对这个键只有「写」和「删」两种动作，绝不原样透传，
 * Host 端的 resolveDynamicWorkflowClientConfig 才能无条件相信读到的值。
 */
function resolveDynamicWorkflowModeHostEnv(options: {
  inheritedValue: string | undefined;
  isPackaged: boolean;
  isPreview: boolean;
}): Record<string, string> {
  if (!options.isPackaged) {
    const mode = normalizeDynamicWorkflowMode(options.inheritedValue);
    return mode ? { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } : {};
  }
  if (options.isPreview) {
    return { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "alwaysOn" };
  }
  return {};
}

export function buildHostProcessEnv(hostProcessLocalEnv: Record<string, string>) {
  // 上游 9976f24 拆除 Computer Use Helper 链路时删除了本声明，但漏删下方
  // resolveDynamicWorkflowModeHostEnv({ isPackaged: packagedDesktop }) 处的引用，
  // 打包产物启动即抛 ReferenceError: packagedDesktop is not defined，
  // 主进程启动链断裂、host 进程不再 spawn，窗口卡在启动页（startup_status_timeout）。
  // 补回声明；isElectronAppPackaged 的 import 本文件本就存在。
  const packagedDesktop = isElectronAppPackaged();
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const larkCliBinaryPath = resolveBundledLarkCliBinaryPath();
  const resolvedGlmBinaryPath = resolveHostProcessBinaryEnv(
    "GLM_BINARY_PATH",
    hostProcessLocalEnv,
    glmBinaryPath,
  );
  const resolvedLarkCliBinaryPath = resolveHostProcessBinaryEnv(
    "ZCODE_LARK_CLI_BINARY",
    hostProcessLocalEnv,
    larkCliBinaryPath,
  );
  const dataBaseDir = getDataBaseDir();
  const rawInheritedEnv = {
    ...hostProcessLocalEnv,
    ...readDefinedProcessEnv(),
  };
  const windowsAppInstallDir = resolveWindowsAppInstallDirForDataBaseDirGuard();
  const inheritedEnv = applySelectedZCodeEnvLinks({
    ...sanitizeZCodeRuntimeEnv(rawInheritedEnv),
    ...buildZCodeToolEnvPassthroughEnv(rawInheritedEnv),
  });
  const dynamicWorkflowModeHostEnv = resolveDynamicWorkflowModeHostEnv({
    inheritedValue: rawInheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV],
    isPackaged: packagedDesktop,
    isPreview: isPreviewPackagedRuntime,
  });
  // 三层里有两层不写这个键，空对象无法覆盖 inheritedEnv，所以先无条件删掉继承值再按决策 spread 回去。
  // 少了这一行，production 包和 dev 的非法取值都会原样穿透到 Host。
  delete inheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV];

  return {
    ...inheritedEnv,
    // ZCode 运行时不再使用 NODE_ENV；它会被用户 shell、包管理器和测试框架复用。
    // 这里显式下发 ZCODE_RUNTIME_ENV，并在继承环境里清掉 NODE_ENV，避免 host/agent/Bash 被污染。
    [ZCODE_RUNTIME_ENV_KEY]: resolveHostProcessNodeEnv(),
    // 显式注入编译期产品身份，保证主进程与 host 的身份语义一致；地址独立解析。
    // inheritedEnv 从 .env 通用变量补齐 ZCode/ZAI 链接，未覆盖时统一使用线上默认值。
    ZCODE_ENV,
    // Preview 与生产版共享任务、配置和凭据，但不同版本的 Helper 不能互相覆盖或触发降级保护。
    // 只隔离 computer-use 下的运行组件，不改写 ZCODE_HOME / ZCODE_DATA_BASE_DIR 业务数据根。
    // Dynamic Workflow 灰度的本地覆盖：Main 决策后写入，production 包为空对象（继承值已在上面删除）。
    ...dynamicWorkflowModeHostEnv,
    // 模型请求默认 header 由 agent 进程构造，过去只继承 shell env 导致桌面启动时拿不到 app 版本。
    // 这里从 main 进程显式下发，agent 子进程继承 host env 后即可稳定写入请求 header。
    [ZCODE_APP_VERSION_ENV]: ZCODE_VERSION,
    ...(dataBaseDir !== homedir() ? { ZCODE_DATA_BASE_DIR: dataBaseDir } : {}),
    ...(windowsAppInstallDir ? { [ZCODE_WINDOWS_APP_INSTALL_DIR_ENV]: windowsAppInstallDir } : {}),
    ...(resolvedGlmBinaryPath ? { GLM_BINARY_PATH: resolvedGlmBinaryPath } : {}),
    ...(resolvedLarkCliBinaryPath ? { ZCODE_LARK_CLI_BINARY: resolvedLarkCliBinaryPath } : {}),
  };
}
