import { isOfficialMarketplaceId } from "@zcode/contracts";
import type { AtomicDirectoryActivation } from "./atomic-directory.js";
import { loadMarketplaceManifestSync } from "./marketplace-manifest.js";
import { toValidationDiagnostic } from "./marketplace-diagnostics.js";
import { loadMarketplaceFromSource } from "./marketplace-source-load.js";
import {
  loadKnownMarketplacesSync,
  persistMarketplaceRefreshFailure,
  stageMarketplaceDirectoryPlugins,
  stageMarketplaceManifest,
  upsertKnownMarketplace,
  writeKnownMarketplaces,
} from "./marketplace-authority.js";
import {
  type KnownMarketplaceActivation,
  type KnownMarketplaceRecord,
  type LoadMarketplaceResult,
  type MarketplaceSource,
  throwIfPluginOperationAborted,
} from "./marketplace-types.js";
import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort } from "./helpers.js";

export async function ensureMarketplaceManifestAvailable(input: {
  marketplace: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord | null> {
  throwIfPluginOperationAborted(input.signal);
  if (loadMarketplaceManifestSync(input.storageRoot, input.marketplace)) {
    return (
      loadKnownMarketplacesSync(input.storageRoot).find(
        (record) => record.id === input.marketplace,
      ) ?? null
    );
  }
  const record = loadKnownMarketplacesSync(input.storageRoot).find(
    (item) => item.id === input.marketplace,
  );
  if (!record || isOfficialMarketplaceId(record.id)) return record ?? null;
  // 个人市场缺缓存时沿用用户已保存的 source；内置身份在此前已返回，不参与懒下载。
  return await addMarketplace({
    signal: input.signal,
    source: record.source,
    storageRoot: input.storageRoot,
    trustedId: record.id,
  });
}

export async function addMarketplace(input: {
  expectedId?: string;
  signal?: AbortSignal;
  source: MarketplaceSource;
  storageRoot: string;
  // 刷新传入现有身份；内置市场只能由随包 seed 更新。
  trustedId?: string;
}): Promise<KnownMarketplaceRecord> {
  // persist:false 先只解析 manifest，不落盘——否则 marketplace 目录激活会用
  // 不可信 manifest.name 作为 target，先 rm 掉本地官方目录再 cp，等守卫抛错时
  // 官方 manifest 已被污染；守卫通过后才持久化。
  throwIfPluginOperationAborted(input.signal);
  if (input.trustedId && isOfficialMarketplaceId(input.trustedId)) {
    throw new Error("Bundled marketplace is managed by the application package");
  }
  const operationSignal = input.signal;
  let loaded: LoadMarketplaceResult | undefined;
  let knownMarketplaceActivation: KnownMarketplaceActivation | undefined;
  let marketplaceActivation: AtomicDirectoryActivation | undefined;
  try {
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: operationSignal,
    });
    throwIfPluginOperationAborted(operationSignal);
    if (isOfficialMarketplaceId(loaded.manifest.name)) {
      throw new Error(
        `Cannot add a marketplace named "${loaded.manifest.name}": that id is reserved for the official marketplace.`,
      );
    }
    if (input.expectedId && loaded.manifest.name !== input.expectedId) {
      throw new Error(
        `Marketplace declaration id mismatch: expected ${input.expectedId}, received ${loaded.manifest.name}`,
      );
    }
    // 旧流程先删 marketplace target 再复制 source，刷新失败会丢失最后成功快照。
    // source tree 与规范 manifest 在同一 staging 目录准备完毕后一次 rename 激活。
    if (loaded.sourceRoot) {
      marketplaceActivation = await stageMarketplaceDirectoryPlugins(
        loaded.sourceRoot,
        input.storageRoot,
        loaded.manifest.name,
        loaded.manifest.raw,
        operationSignal,
      );
    } else {
      marketplaceActivation = await stageMarketplaceManifest(
        input.storageRoot,
        loaded.manifest.name,
        loaded.manifest.raw,
        operationSignal,
      );
    }
    throwIfPluginOperationAborted(operationSignal);
    const now = new Date().toISOString();
    const record: KnownMarketplaceRecord = {
      id: loaded.manifest.name,
      source: input.source,
      name: loaded.manifest.name,
      ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
      addedAt: now,
      lastUpdated: now,
      pluginCount: loaded.manifest.plugins.length,
      ...(marketplaceActivation ? { cacheTransactionId: marketplaceActivation.transactionId } : {}),
    };
    knownMarketplaceActivation = await upsertKnownMarketplace(input.storageRoot, record);
    if (marketplaceActivation) {
      throwIfPluginOperationAborted(operationSignal);
    }
    // authority state 已落盘后才进入不可取消的提交尾声，随后清理 backup/marker。
    await marketplaceActivation?.finalize();
    knownMarketplaceActivation.finalize();
    return record;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await knownMarketplaceActivation?.rollback();
    } catch (currentRollbackError) {
      rollbackError = currentRollbackError;
    }
    try {
      if (rollbackError === undefined) {
        await marketplaceActivation?.rollback();
      } else {
        // authority 无法恢复时保留其指向的新 manifest，避免再次制造跨代状态。
        await marketplaceActivation?.finalize();
      }
    } catch (currentRollbackError) {
      rollbackError =
        rollbackError === undefined
          ? currentRollbackError
          : appendPluginSourceCleanupError(currentRollbackError, rollbackError);
    }
    throw appendPluginSourceCleanupError(error, rollbackError);
  } finally {
    await cleanupPluginSourceBestEffort(loaded?.cleanup);
  }
}

export async function updateMarketplace(input: {
  marketplace?: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord[]> {
  const known = loadKnownMarketplacesSync(input.storageRoot);
  const selected = input.marketplace
    ? known.filter((record) => record.id === input.marketplace)
    : known;
  if (input.marketplace && selected.length === 0) {
    throw new Error(`Marketplace not found: ${input.marketplace}`);
  }
  const updated: KnownMarketplaceRecord[] = [];
  for (const record of selected) {
    throwIfPluginOperationAborted(input.signal);

    if (isOfficialMarketplaceId(record.id)) {
      updated.push(record);
      continue;
    }
    // 只有用户添加的来源会显式刷新；内置目录不参与下载或错误状态持久化。
    try {
      updated.push(
        await addMarketplace({
          signal: input.signal,
          source: record.source,
          storageRoot: input.storageRoot,
          trustedId: record.id,
        }),
      );
    } catch (error) {
      // 取消是当前 operation 的控制流，不是 Marketplace 健康状态；不得把 AbortError
      // 持久化成 refresh failure，避免后续普通商店页面误报官方源故障。
      if (input.signal?.aborted) throw error;
      const diagnostic = toValidationDiagnostic(error, record.id);
      await persistMarketplaceRefreshFailure(input.storageRoot, record.id, {
        code: diagnostic.code,
        failedAt: new Date().toISOString(),
        message: diagnostic.message,
      });
    }
  }
  return updated;
}

export async function removeMarketplace(input: {
  marketplace: string;
  storageRoot: string;
}): Promise<void> {
  if (isOfficialMarketplaceId(input.marketplace)) {
    throw new Error("Bundled marketplace cannot be removed");
  }
  const known = loadKnownMarketplacesSync(input.storageRoot).filter(
    (record) => record.id !== input.marketplace,
  );
  await writeKnownMarketplaces(input.storageRoot, known);
}
