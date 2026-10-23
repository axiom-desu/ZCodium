import type {
  AddZCodeMarketplaceOptions,
  RemoveZCodeMarketplaceOptions,
  UpdateZCodeMarketplaceOptions,
  ValidateZCodePluginPathOptions,
  ZCodeMarketplaceSummaryData,
  ZCodeMarketplaceUpdateData,
} from "./plugin-types.js";
import { resolvePluginContext } from "./plugin-context.js";
import {
  createMarketplaceSourceRepointDiagnostic,
  toMarketplaceRefreshDiagnostic,
  toMarketplaceSummaryData,
  toPluginDiagnostic,
} from "./plugin-data.js";
import {
  resolveDeclaredMarketplaceSources,
  resolveMarketplaceRefreshTargetIds,
} from "./plugin-marketplace-declaration.js";
import type { KnownMarketplaceRecord, MarketplaceSource } from "@zcode/adapters/plugins";
import { isDeepStrictEqual } from "node:util";
import {
  addMarketplace,
  loadKnownMarketplacesSync,
  parseMarketplaceSourceInput,
  removeMarketplace,
  updateMarketplace,
  validateLocalPluginPath,
} from "@zcode/adapters/plugins";
import type { PluginLoadOutcome } from "@zcode/contracts";
export async function addZCodePluginMarketplace(
  options: AddZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceSummaryData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const source = applySparsePaths(
    await parseMarketplaceSourceInput(options.source),
    options.sparsePaths,
  );
  if (options.dryRun === true) {
    return {
      id: "dry-run",
      name: "dry-run",
      source: source as unknown as Record<string, unknown>,
      pluginCount: 0,
      isOfficial: false,
    };
  }
  const record = await addMarketplace({
    signal: options.abortSignal,
    source,
    storageRoot: pluginStorageRoot,
  });
  return toMarketplaceSummaryData(record);
}

export async function removeZCodePluginMarketplace(
  options: RemoveZCodeMarketplaceOptions,
): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await removeMarketplace({
    marketplace: options.marketplace,
    storageRoot: pluginStorageRoot,
  });
}

export async function updateZCodePluginMarketplace(
  options: UpdateZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceUpdateData> {
  const { configResult, pluginStorageRoot } = resolvePluginContext(options);
  const declared = resolveDeclaredMarketplaceSources({
    configResult,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const knownById = new Map(known.map((record) => [record.id, record]));
  const targetIds = resolveMarketplaceRefreshTargetIds({
    declaredIds: declared.keys(),
    knownIds: knownById.keys(),
    marketplace: options.marketplace,
  });
  if (
    options.marketplace &&
    !knownById.has(options.marketplace) &&
    !declared.has(options.marketplace)
  ) {
    throw new Error(`Marketplace not found: ${options.marketplace}`);
  }

  const updated: KnownMarketplaceRecord[] = [];
  const declarationDiagnostics: PluginLoadOutcome["diagnostics"] = [];
  for (const marketplaceId of targetIds) {
    const declarationSource = declared.get(marketplaceId);
    const knownRecord = knownById.get(marketplaceId);
    if (
      options.marketplace &&
      declarationSource &&
      knownRecord &&
      !isDeepStrictEqual(knownRecord.source, declarationSource)
    ) {
      declarationDiagnostics.push(createMarketplaceSourceRepointDiagnostic(marketplaceId));
      continue;
    }
    if (declarationSource && !knownRecord) {
      try {
        updated.push(
          await addMarketplace({
            expectedId: marketplaceId,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          }),
        );
      } catch (error) {
        declarationDiagnostics.push(toMarketplaceRefreshDiagnostic(error, marketplaceId));
      }
      continue;
    }
    updated.push(
      ...(await updateMarketplace({
        marketplace: marketplaceId,
        signal: options.abortSignal,
        storageRoot: pluginStorageRoot,
      })),
    );
  }

  // map 回调只吃第一个参数：toMarketplaceSummaryData 的第二参是 featured，不能接 map 的 index。
  const records = loadKnownMarketplacesSync(pluginStorageRoot);
  const selectedFailures = records.flatMap((record): PluginLoadOutcome["diagnostics"] => {
    if (options.marketplace && record.id !== options.marketplace) return [];
    if (!record.lastRefreshFailure) return [];
    return [
      {
        code: record.lastRefreshFailure.code,
        message: record.lastRefreshFailure.message,
        pluginId: record.id,
        severity: "error",
      },
    ];
  });
  return {
    marketplaces: updated.map((record) => toMarketplaceSummaryData(record)),
    diagnostics: [...declarationDiagnostics, ...selectedFailures],
  };
}

export async function validateZCodePluginPath(
  options: ValidateZCodePluginPathOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  return (
    await validateLocalPluginPath({
      path: options.path,
      signal: options.abortSignal,
      storageRoot: pluginStorageRoot,
    })
  ).map(toPluginDiagnostic);
}

function applySparsePaths(
  source: MarketplaceSource,
  sparsePaths: string[] | undefined,
): MarketplaceSource {
  const paths = (sparsePaths ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (paths.length === 0) return source;
  if (source.source !== "git" && source.source !== "github") {
    throw new Error("--sparse only applies to git or GitHub marketplace sources");
  }
  return { ...source, sparsePaths: paths };
}

/**
 * 恢复一个被抑制（uninstall）的内置（官方）插件的无锁核心。
 *
 * 调用方可能已经持有同一 storageRoot 的 storage lock（例如协议 install handler），
 * 因此核心不能再次获取 promise-chain lock；公开入口再负责提供锁保护。
 */
