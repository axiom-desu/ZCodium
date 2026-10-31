import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { isZCodeCuaInternalFeatureEnabled, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { validateStagedOfficeViewerAssets } from "@zcode/shared/office-viewer-assets";
import {
  createOfficialPluginCacheRetryBudget,
  isTransientOfficialPluginCacheFsError,
  removeOfficialPluginCacheDirectory,
  type OfficialPluginCacheRetryBudget,
} from "./official-plugin-cache-fs.js";
import type { OfficialPluginDefinition } from "./official-plugin-definitions.js";
import { writeOfficialPluginRuntimeManifest } from "./official-plugin-runtime.js";
import {
  isOfficialPluginSeedLockTimeoutError,
  withOfficialPluginSeedLock,
} from "./official-plugin-seed-lock.js";
import {
  OFFICIAL_PLUGIN_MARKETPLACE,
  SEED_MARKER_FILE,
  hashBytes,
  modeForSeedFile,
  readSeedFileBytes,
  resolveSeedSource,
  uniquePaths,
  type OfficialPluginSeedPluginSource,
  type OfficialPluginSeedSource,
} from "./bundled-plugin-seed-source.js";
import {
  cleanupLegacySeedBackup,
  findUsableOfficialPluginFallback,
  isNotFoundFsError,
  isSeedCurrent,
  officialPluginCacheRoot,
  replaceSeedRoot,
  seedMarker,
  warnCacheDegraded,
  writeOfficialMarketplace,
} from "./bundled-plugin-seed-cache.js";

const SEED_LOCK_TOTAL_BUDGET_MS = 15_000;
/** seed 内容本身残缺（缺资源/哈希不符）的稳定错误码，供降级协议分流。 */
const SEED_INCOMPLETE_ERROR_CODE = "ZCODE_PLUGIN_SEED_INCOMPLETE";

function seedIncompleteError(plugin: OfficialPluginSeedPluginSource, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(
    new Error(`Bundled official plugin ${plugin.definition.name} seed is incomplete: ${reason}`, {
      cause,
    }),
    { code: SEED_INCOMPLETE_ERROR_CODE },
  );
}

function isSeedIncompleteError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === SEED_INCOMPLETE_ERROR_CODE
  );
}

async function seedBundledOfficialPlugins(input: {
  baseDirs?: readonly string[];
  logger?: Logger;
  seedSource?: OfficialPluginSeedSource;
  storageRoot: string;
}): Promise<OfficialPluginDefinition[]> {
  const source = input.seedSource ?? (await resolveSeedSource({ baseDirs: input.baseDirs }));
  if (!source) return [];

  // Catalog/cache 是内置插件的不可变产品资产；Runtime 是否加载由 discovery 的抑制态决定，
  // 不能在 seed 阶段删除或过滤，否则卸载后详情页无法读取组件，也无法恢复。
  await writeOfficialMarketplace(input.storageRoot, source);
  const retryBudget = createOfficialPluginCacheRetryBudget();
  // 等锁超时降级后循环会继续；若每个插件独立重置 15s 等待预算，成组遗留的
  // 锁会让启动同步冻结 N×15s。全部插件共享同一截止时间：无争用的锁仍瞬时获取（mkdir
  // 一次成功不查预算），预算耗尽后有争用的锁立即降级，seeding 总等待封顶 15s。
  const seedLockDeadlineAt = Date.now() + SEED_LOCK_TOTAL_BUDGET_MS;
  const failedSeeds: OfficialPluginDefinition[] = [];
  for (const plugin of source.plugins) {
    const pluginId = `${plugin.definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}`;
    const targetRoot = officialPluginCacheRoot(input.storageRoot, plugin.definition);
    // 入口旁的插件拷贝可能与新定义错配（升级中的桌面包、旧 checkout 未构建 dist）。
    // 缺 requiredSeedPaths 时 seed 源解析曾直接抛错，一个残缺插件把全部插件连同会话恢复
    // 一起炸成 resumeFailed。残缺只作用于单插件：拒绝写缓存，按既有降级协议告警并回退到可用旧缓存。
    if (plugin.missingSeedPaths.length > 0) {
      warnCacheDegraded(input.logger, {
        error: Object.assign(
          new Error(
            `Bundled official plugin ${plugin.definition.name} is missing required seed assets: ${plugin.missingSeedPaths.join(", ")}`,
          ),
          { code: SEED_INCOMPLETE_ERROR_CODE },
        ),
        missingSeedPaths: plugin.missingSeedPaths,
        operation: "seed_plugin",
        pluginId,
        reason: `missing required seed assets: ${plugin.missingSeedPaths.join(", ")}`,
        targetRoot,
      });
      failedSeeds.push(plugin.definition);
      continue;
    }
    try {
      await withOfficialPluginSeedLock(
        targetRoot,
        async () => {
          // 桌面会并发预热多个 workspace Agent；复制插件资源时，
          // 多进程会互删 target 并在 Windows rename 时触发 EPERM。拿锁后必须二次检查，
          // 让等待者直接复用首个进程已经提交的完整缓存。
          if (await isSeedCurrent(targetRoot, plugin)) {
            cleanupLegacySeedBackup(targetRoot, retryBudget);
            const manifestWritten = tryWriteOfficialPluginRuntimeManifest({
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
            if (manifestWritten) return;
          }

          const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
          removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
          await mkdir(temporaryRoot, { recursive: true });

          try {
            for (const file of plugin.files) {
              let bytes: Buffer;
              try {
                bytes = await readSeedFileBytes(source, plugin, file);
              } catch (error) {
                // SEA 内嵌资产缺键 / 磁盘上 seed 文件读不到：同属 seed 内容残缺，
                // 降级保留旧缓存，不把会话恢复一起炸掉。
                throw seedIncompleteError(plugin, error);
              }
              if (hashBytes(bytes) !== file.sha256) {
                // seed 字节与清单不符是「seed 内容残缺」，不是宿主文件系统故障：
                // 按降级协议保留旧可用缓存，而不是把整个启动炸掉。
                throw seedIncompleteError(
                  plugin,
                  new Error(`Bundled plugin asset hash mismatch: ${file.path}`),
                );
              }
              const outputPath = join(temporaryRoot, ...file.path.split("/"));
              await mkdir(dirname(outputPath), { recursive: true });
              await writeFile(outputPath, bytes);
              await chmod(outputPath, modeForSeedFile(file.path, file.mode));
            }

            // 修复：filesystem dev 与 SEA 的 seed 过去只校验入口 5 文件，删掉任一字体/worker/
            // wasm/NOTICE 仍会把半成品 promote 进缓存。现在在 promote 之前对真实 staging
            // 目录跑与构建期同一份 office 闭包适配器；缺资源/哈希不符都拒绝激活。
            try {
              await validateStagedOfficeViewerAssets(temporaryRoot);
            } catch (error) {
              throw seedIncompleteError(plugin, error);
            }

            await writeFile(
              join(temporaryRoot, SEED_MARKER_FILE),
              JSON.stringify(seedMarker(source, plugin), null, 2),
            );
            await replaceSeedRoot(temporaryRoot, targetRoot, plugin, retryBudget);
            writeOfficialPluginRuntimeManifest({
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
          } catch (error) {
            try {
              removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
            } catch {
              // 临时目录清理失败不能覆盖真正的 seed 错误；目录名唯一，不会污染后续加载。
            }
            throw error;
          }
        },
        { timeoutMs: Math.max(0, seedLockDeadlineAt - Date.now()) },
      );
    } catch (error) {
      if (
        isTransientOfficialPluginCacheFsError(error) ||
        // seed lock 等待超时只说明同版本缓存锁被别的进程持有或遗留（Windows 上
        // 删不掉的遗留锁 + PID 复用会让接管长期不触发）。seeding 只是刷新缓存，超时必须
        // 走既有降级协议回退到可用缓存并告警，不能把会话恢复整体炸成 resumeFailed。
        isOfficialPluginSeedLockTimeoutError(error) ||
        // seed 内容残缺（缺字体/worker/NOTICE、哈希不符、office profile 缺失）与缺
        // requiredSeedPaths 同一语义：单插件降级，保留旧可用缓存。
        isSeedIncompleteError(error) ||
        // 多个 workspace app 会并发 seed 同一份官方插件缓存。当前进程
        // 写 runtime manifest 时，并发赢家可能已经原子替换整个 targetRoot，连同本进程
        // 的临时文件一起移走，rename 因此返回 ENOENT。只在新 target 已由 marker 证明
        // 完整时降级；目标缺失或仍旧时继续抛错，不能掩盖真实缓存损坏。
        (isNotFoundFsError(error) && (await isSeedCurrent(targetRoot, plugin)))
      ) {
        warnCacheDegraded(input.logger, {
          error,
          operation: "seed_plugin",
          pluginId,
          reason: error instanceof Error ? error.message : String(error),
          targetRoot,
        });
        failedSeeds.push(plugin.definition);
        continue;
      }
      throw error;
    }
  }
  return failedSeeds;
}

function tryWriteOfficialPluginRuntimeManifest(input: {
  pluginName: string;
  retryBudget: OfficialPluginCacheRetryBudget;
  rootPath: string;
}): boolean {
  try {
    writeOfficialPluginRuntimeManifest(input);
    return true;
  } catch (error) {
    if (isTransientOfficialPluginCacheFsError(error)) throw error;
    return false;
  }
}

export async function resolveOfficialPluginRoots(input: {
  baseDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  extraRoots?: string[];
  logger?: Logger;
  /**
   * 已解析好的 seed 源（仅用于验收 SEA 变体：内嵌资产无法在普通 Node 进程里构造，
   * 但 staging/promote/降级路径必须与运行时完全一致）。生产调用方不传。
   */
  seedSource?: OfficialPluginSeedSource;
  storageRoot: string;
  suppressedBuiltins?: ReadonlySet<string>;
}): Promise<string[]> {
  const suppressedBuiltins = new Set(input.suppressedBuiltins ?? []);
  // zcode-cua 内置 plugin 默认不启用，由 feature flag 控制加载。在 seed/discovery 层门控
  // （而非只隐藏某个 UI 面），这样开关关闭时用户无法经 plugin 列表/marketplace/MCP 设置/CLI 命令看到它。
  if (!isZCodeCuaInternalFeatureEnabled(input.env ?? process.env)) {
    suppressedBuiltins.add(ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  }
  const failedSeeds = await seedBundledOfficialPlugins({
    baseDirs: input.baseDirs,
    logger: input.logger,
    seedSource: input.seedSource,
    storageRoot: input.storageRoot,
  });

  const fallbackRoots: string[] = [];
  for (const definition of failedSeeds) {
    // CUA 的 frame contract 随 wrapper 与 producer 原子升级。加载旧版本
    // cache 会把旧 block 布局接到新 consumer 上；当前 cache 不可用时宁可不注册 CUA。
    if (`${definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}` === ZCODE_CUA_OFFICIAL_PLUGIN_ID) {
      continue;
    }
    const fallbackRoot = await findUsableOfficialPluginFallback(input.storageRoot, definition);
    if (fallbackRoot) fallbackRoots.push(fallbackRoot);
  }
  return uniquePaths([...(input.extraRoots ?? []), ...fallbackRoots]);
}

export function candidateBaseDirs(): string[] {
  // 修复原因：Electron app-server 运行在 resources/glm/zcode.cjs，官方插件资源也随桌面包
  // stage 到同级 packages/*-plugin。候选目录必须优先看入口文件目录，避免生产态退回到
  // monorepo-only 的 __dirname 查找假设。
  return [entrypointDir(), runtimeDir(), process.cwd()].filter(
    (dir): dir is string => typeof dir === "string",
  );
}

function runtimeDir(): string | undefined {
  return typeof __dirname === "string" ? __dirname : undefined;
}

function entrypointDir(): string | undefined {
  return process.argv[1] ? dirname(process.argv[1]) : undefined;
}
