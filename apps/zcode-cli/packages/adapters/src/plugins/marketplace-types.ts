import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PluginDiagnostic, PluginStoreListing } from "@zcode/contracts";
import { sanitizeZCodeRuntimeEnv } from "@zcode/shared";
import {
  recoverAtomicTargetSync,
  writeFileAtomically,
  type AtomicDirectoryActivation,
} from "./atomic-directory.js";
import type { PluginComponentGroup } from "./plugin-components.js";
import { sanitizePluginId } from "./helpers.js";
import { applyNetworkEgressEnv } from "../network/subprocess-env.js";

export const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";
export const INSTALLED_PLUGINS_FILE = "installed_plugins.json";
export const MARKETPLACE_FILE = "marketplace.json";
export const MARKETPLACE_JSON_MAX_BYTES = 10 * 1024 * 1024;
export const MARKETPLACE_JSON_MAX_REDIRECTS = 5;
export const MARKETPLACE_JSON_TIMEOUT_MS = 180_000;
export const CLAUDE_MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");
export const ZCODE_MANIFEST_PATH = join(".zcodium-plugin", "plugin.json");
export const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
export const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
export const DEFAULT_VERSION = "0.0.0";
export const GIT_CLONE_MAX_ATTEMPTS = 3;
export const GIT_COMMAND_TIMEOUT_MS = 90_000;
export const GIT_CLONE_RETRY_DELAY_MS = 1_000;
export const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const SOURCE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const UNSUPPORTED_MANIFEST_FIELDS = [
  "channels",
  "lspServers",
  "outputStyles",
  "settings",
] as const;

export type MarketplaceSource =
  | { source: "bundled" }
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string }
  | { hostPattern: string; source: "hostPattern" }
  | { pathPattern: string; source: "pathPattern" }
  | { source: "settings"; marketplace: PluginMarketplaceManifest };

export interface PluginMarketplaceEntry {
  name: string;
  category?: string;
  description?: string;
  version?: string;
  source?: unknown;
  // 内置 official 插件 seed 时写入的缓存目录绝对路径（source 为 "filesystem"/"sea"）。
  // describe/解析时据此直接定位已落盘的插件根目录，无需把 source 当路径解析。
  cachePath?: string;
  dependencies?: string[];
  strict?: boolean;
  tags?: string[];
  // 商店信息（displayName/icon/hero/示例提示词/链接等展示元数据），从条目 raw 解析；
  // 全部可选，见 contracts PluginStoreListing。
  listing?: PluginStoreListing;
  raw: Record<string, unknown>;
}

export interface PluginMarketplaceManifest {
  name: string;
  description?: string;
  plugins: PluginMarketplaceEntry[];
  allowCrossMarketplaceDependenciesOn?: string[];
  pluginRoot?: string;
  // 商店「公开」分段的随包精选名单（插件 name，按序）。
  featured?: string[];
  raw: Record<string, unknown>;
}

export interface KnownMarketplaceRecord {
  id: string;
  source: MarketplaceSource;
  name: string;
  description?: string;
  addedAt: string;
  lastUpdated?: string;
  lastRefreshFailure?: MarketplaceRefreshFailure;
  pluginCount: number;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface MarketplaceRefreshFailure {
  code: PluginDiagnostic["code"];
  failedAt: string;
  message: string;
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  installPath: string;
  installedAt: string;
  updatedAt?: string;
  scope: "user" | "workspace";
  dependencies?: string[];
  source?: unknown;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface InstalledPluginsState {
  version: 1;
  plugins: InstalledPluginRecord[];
}

export interface MarketplaceInstallResult {
  closure: string[];
  installed: InstalledPluginRecord[];
}

export interface PluginValidationDiagnostic {
  code: PluginDiagnostic["code"];
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnostic["severity"];
}

// 组件枚举的类型定义在 plugin-components.ts；这里只再导出本模块自身公开面消费的
// PluginComponentGroup（DescribeMarketplacePluginResult 引用它）。Item/Kind 的对外
// 契约由 plugins/marketplace.ts（HEAD 的 public surface）从 plugin-components 直接透传，
// 不在本模块重复一层无人消费的 pass-through。
export type { PluginComponentGroup } from "./plugin-components.js";

export interface DescribeMarketplacePluginResult {
  components: PluginComponentGroup[];
  diagnostics: PluginValidationDiagnostic[];
  // 插件包内 plugin.json 的展示性回退字段（作者/主页/版本）；商店信息缺失时详情页信息区用它兜底。
  metadata?: PluginManifestDisplayMetadata;
}

export interface PluginManifestDisplayMetadata {
  author?: string;
  authorUrl?: string;
  homepage?: string;
  version?: string;
}

export function buildMarketplaceGitEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = sanitizeZCodeRuntimeEnv(sourceEnv);
  // marketplace 安装会启动 Git 子进程，不能只依赖父进程继承的 shell 代理。
  // 这里统一从 ZCode 显式网络环境恢复 HTTP(S)/NO_PROXY/CA，避免安装按钮卡到协议超时。
  return applyNetworkEgressEnv(env, { sourceEnv });
}

export function throwIfPluginOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createPluginOperationCancelledError();
  }
}

function createPluginOperationCancelledError(): Error {
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  return error;
}

export interface KnownMarketplaceActivation {
  finalize: () => void;
  rollback: () => Promise<void>;
}

export interface LoadMarketplaceResult {
  cleanup?: () => Promise<void>;
  manifest: PluginMarketplaceManifest;
  sourceRoot?: string;
}

export interface ResolvedPluginSourceRoot {
  cleanup?: () => Promise<void>;
  path: string;
}

export interface CachedMarketplacePluginResult {
  activation?: AtomicDirectoryActivation;
  record: InstalledPluginRecord;
}
export function getMarketplaceManifestPath(storageRoot: string, marketplace: string): string {
  return join(storageRoot, "marketplaces", sanitizePluginId(marketplace), MARKETPLACE_FILE);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(createPluginOperationCancelledError());
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = (): void => {
      cleanup();
      rejectDelay(createPluginOperationCancelledError());
    };
    timeout = setTimeout(() => {
      cleanup();
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export class UnsupportedMarketplaceSourceError extends Error {
  constructor(source: string) {
    super(`Marketplace source is recognized but not supported in this runtime: ${source}`);
  }
}

export class UnsupportedPluginSourceError extends Error {
  constructor(source: string) {
    super(`Plugin source is recognized but not supported in this runtime: ${source}`);
  }
}

export function readJsonFileSync(path: string): unknown {
  const readablePath = recoverAtomicTargetSync(path);
  try {
    return JSON.parse(readFileSync(readablePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function getPluginCacheDir(
  storageRoot: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  return join(
    storageRoot,
    "cache",
    sanitizePluginId(marketplace),
    sanitizePluginId(name),
    sanitizePluginId(version),
  );
}

export function getPluginDataDir(storageRoot: string, pluginId: string): string {
  // 与 NodePluginAdapter.discoverPluginsSync 的 dataPath 解析保持一致：<storageRoot>/data/<sanitized-id>。
  return join(storageRoot, "data", sanitizePluginId(pluginId));
}

export function resolvePathInput(input: string): string | null {
  if (
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("/") ||
    input.startsWith("~") ||
    /^[a-zA-Z]:[/\\]/.test(input)
  ) {
    return input.startsWith("~") ? join(process.env.HOME ?? "", input.slice(1)) : resolve(input);
  }
  return null;
}

export function splitRef(input: string): { ref?: string; url: string } {
  const index = input.lastIndexOf("#");
  if (index < 0) return { url: input };
  return { url: input.slice(0, index), ref: input.slice(index + 1) };
}

export function splitGitHubShorthand(input: string): { ref?: string; url: string } {
  const hash = input.lastIndexOf("#");
  const at = input.lastIndexOf("@");
  const index = Math.max(hash, at);
  if (index <= 0) return { url: input };
  return { url: input.slice(0, index), ref: input.slice(index + 1) };
}

export function isGitSshUrl(input: string): boolean {
  return /^[a-zA-Z0-9._-]+@[^:]+:.+/.test(input);
}

export function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export function createManifestFromMarketplaceEntry(
  entry: PluginMarketplaceEntry,
): Record<string, unknown> {
  const raw = { ...entry.raw };
  delete raw.source;
  delete raw.category;
  delete raw.tags;
  delete raw.strict;
  // 商店信息（Store Listing）是目录层展示元数据，不属于插件 manifest；
  // 合成 manifest 时剔除，避免污染 plugin.json 语义（author/homepage 是合法 manifest 字段，保留）。
  delete raw.displayName;
  delete raw.displayName_i18n;
  delete raw.description_i18n;
  delete raw.icon;
  delete raw.privacyPolicy;
  delete raw.termsOfService;
  delete raw.heroImage;
  delete raw.examplePrompts;
  delete raw.examplePrompts_i18n;
  delete raw.requiresPaidPlan;
  return {
    ...raw,
    name: entry.name,
    version: entry.version ?? DEFAULT_VERSION,
  };
}
