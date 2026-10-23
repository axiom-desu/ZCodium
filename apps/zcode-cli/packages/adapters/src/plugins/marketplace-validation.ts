import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isRecord } from "./helpers.js";
import { cleanupPluginSourceBestEffort } from "./helpers.js";
import {
  type LoadMarketplaceResult,
  type MarketplaceSource,
  type PluginValidationDiagnostic,
  type ResolvedPluginSourceRoot,
  getMarketplaceManifestPath,
} from "./marketplace-types.js";
import {
  findMarketplaceManifestPath,
  findPluginManifestPath,
  loadMarketplaceManifestSync,
} from "./marketplace-manifest.js";
import { ensureMarketplaceManifestAvailable } from "./marketplace-refresh.js";
import { loadMarketplaceFromSource } from "./marketplace-source-load.js";
import { resolvePluginSourceRoot } from "./marketplace-source.js";
import {
  validatePluginRoot,
  validateMarketplaceEntryShape,
  getMarketplaceSourceValidationDeferral,
  toValidationDiagnostic,
} from "./marketplace-diagnostics.js";
import {
  pushDependencyDiagnostics,
  pushDependencyDiagnosticsFromManifest,
} from "./marketplace-dependencies.js";
import { pushEntryCompatibilityDiagnostics } from "./marketplace-diagnostics.js";

export async function validateMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  try {
    await ensureMarketplaceManifestAvailable({
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
    return diagnostics;
  }
  const manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  if (!manifest) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Marketplace not found: ${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return diagnostics;
  }
  const plugin = manifest.plugins.find((entry) => entry.name === input.name);
  if (!plugin) {
    diagnostics.push({
      code: "plugin_not_found",
      message: `Plugin not found: ${input.name}@${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return diagnostics;
  }

  pushDependencyDiagnostics({
    diagnostics,
    marketplace: input.marketplace,
    name: input.name,
    storageRoot: input.storageRoot,
  });

  let resolved: ResolvedPluginSourceRoot | null = null;
  try {
    resolved = await resolvePluginSourceRoot({
      entry: plugin,
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
    diagnostics.push(
      ...validatePluginRoot({
        entry: plugin,
        marketplace: input.marketplace,
        rootPath: resolved.path,
        storageRoot: input.storageRoot,
      }),
    );
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  } finally {
    await cleanupPluginSourceBestEffort(resolved?.cleanup);
  }
  return diagnostics;
}

/**
 * 按需枚举单个插件的组件「名称 + 描述」，供 marketplace 详情 UI 使用。
 * - 已安装插件：直接读本地缓存/安装目录，无需联网。
 * - 未安装候选：解析并按需临时 clone 插件源（finally 清理临时目录），参照 validateMarketplacePlugin。
 * 组件名称与描述来自组件目录的 frontmatter（command/agent 的 .md、skill 的 SKILL.md）、
 * 以及 manifest（hooks 事件名、mcpServers 名称、object 形式声明的 commands/agents）。
 * 任何一类组件读取失败都降级为「能拿到多少返回多少」+ 诊断，不抛断整个详情。
 */
export async function validateMarketplaceSource(input: {
  expectedId?: string;
  pluginName?: string;
  signal?: AbortSignal;
  source: MarketplaceSource;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  let loaded: LoadMarketplaceResult | null = null;
  try {
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: input.signal,
    });
    if (input.expectedId && loaded.manifest.name !== input.expectedId) {
      diagnostics.push({
        code: "plugin_marketplace_invalid",
        message:
          `Marketplace declaration id mismatch: expected ${input.expectedId}, ` +
          `received ${loaded.manifest.name}`,
        pluginId: input.expectedId,
        severity: "error",
      });
      return diagnostics;
    }
    if (loaded.manifest.plugins.length === 0) {
      diagnostics.push({
        code: "plugin_marketplace_invalid",
        message: `Marketplace has no plugins: ${loaded.manifest.name}`,
        severity: "warning",
      });
    }
    const entries = input.pluginName
      ? loaded.manifest.plugins.filter((entry) => entry.name === input.pluginName)
      : loaded.manifest.plugins;
    if (input.pluginName && entries.length === 0) {
      diagnostics.push({
        code: "plugin_not_found",
        message: `Plugin not found: ${input.pluginName}@${loaded.manifest.name}`,
        pluginId: `${input.pluginName}@${loaded.manifest.name}`,
        severity: "error",
      });
      return diagnostics;
    }
    for (const entry of entries) {
      diagnostics.push(
        ...validateMarketplaceEntryShape(entry, loaded.manifest.name, {
          includeEntryCompatibility: false,
        }),
      );
      pushDependencyDiagnosticsFromManifest({
        diagnostics,
        manifest: loaded.manifest,
        marketplace: loaded.manifest.name,
        name: entry.name,
        storageRoot: input.storageRoot,
      });
      const deferred = getMarketplaceSourceValidationDeferral(entry, loaded.manifest.name);
      if (deferred) {
        diagnostics.push(deferred);
        pushEntryCompatibilityDiagnostics({
          diagnostics,
          entry,
          marketplace: loaded.manifest.name,
        });
        continue;
      }
      let resolved: ResolvedPluginSourceRoot | null = null;
      try {
        resolved = await resolvePluginSourceRoot({
          entry,
          marketplace: loaded.manifest.name,
          manifest: loaded.manifest,
          signal: input.signal,
          sourceRoot: loaded.sourceRoot,
          storageRoot: input.storageRoot,
        });
        diagnostics.push(
          ...validatePluginRoot({
            entry,
            marketplace: loaded.manifest.name,
            rootPath: resolved.path,
            storageRoot: input.storageRoot,
          }),
        );
      } catch (error) {
        diagnostics.push(toValidationDiagnostic(error, `${entry.name}@${loaded.manifest.name}`));
        // validate source 是 dry-run, 但也必须给 UI 展示 marketplace 条目里声明的能力风险。
        // 当远端/相对 plugin source 暂时不可解析时, 仍基于 entry 原文输出 diagnostic-only 能力诊断。
        pushEntryCompatibilityDiagnostics({
          diagnostics,
          entry,
          marketplace: loaded.manifest.name,
        });
      } finally {
        await cleanupPluginSourceBestEffort(resolved?.cleanup);
      }
    }
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error));
  } finally {
    await cleanupPluginSourceBestEffort(loaded?.cleanup);
  }
  return diagnostics;
}

/**
 * 校验本地插件或 marketplace 路径，只读解析 manifest 并返回结构化诊断，不写入 storage。
 * 输入可以是目录或 manifest 文件；目录按 marketplace 优先、插件根目录其次的顺序识别。
 */
export async function validateLocalPluginPath(input: {
  path: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const resolved = resolve(input.path);
  if (!existsSync(resolved)) {
    return [
      {
        code: "plugin_manifest_not_found",
        message: `Path does not exist: ${resolved}`,
        path: resolved,
        severity: "error",
      },
    ];
  }
  const rootPath = statSync(resolved).isDirectory()
    ? resolved
    : resolveManifestRootFromFile(resolved);
  if (findMarketplaceManifestPath(rootPath)) {
    return validateMarketplaceSource({
      signal: input.signal,
      source: { source: "directory", path: rootPath },
      storageRoot: input.storageRoot,
    });
  }
  const manifestPath = findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return [
      {
        code: "plugin_manifest_not_found",
        message: `Plugin manifest not found: ${rootPath}`,
        path: rootPath,
        severity: "error",
      },
    ];
  }
  let name = "";
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.name === "string") name = parsed.name.trim();
  } catch (error) {
    return [
      {
        code: "plugin_manifest_invalid",
        message: error instanceof Error ? error.message : String(error),
        path: manifestPath,
        severity: "error",
      },
    ];
  }
  // 本地目录没有 marketplace 条目：用 manifest 自己的 name 合成一个 strict 条目，
  // 让 validatePluginRoot 走与已安装插件完全相同的 manifest/MCP 校验。
  return validatePluginRoot({
    entry: { name: name || basename(rootPath), raw: {} },
    marketplace: "inline",
    rootPath,
    storageRoot: input.storageRoot,
  });
}

/** 用户传入 manifest 文件时，回推对应的插件根目录。 */
function resolveManifestRootFromFile(filePath: string): string {
  const dir = dirname(filePath);
  const dirName = basename(dir);
  return dirName.startsWith(".") && dirName.endsWith("-plugin") ? dirname(dir) : dir;
}
