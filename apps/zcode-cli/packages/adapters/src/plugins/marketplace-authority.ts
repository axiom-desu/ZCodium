import { isOfficialMarketplaceId } from "@zcode/contracts";
import { dirname, join } from "node:path";
import { activateDirectoryAtomically, type AtomicDirectoryActivation } from "./atomic-directory.js";
import {
  KNOWN_MARKETPLACES_FILE,
  MARKETPLACE_FILE,
  type KnownMarketplaceActivation,
  type KnownMarketplaceRecord,
  type MarketplaceRefreshFailure,
  getMarketplaceManifestPath,
  readJsonFileSync,
  throwIfPluginOperationAborted,
  writeJsonFile,
} from "./marketplace-types.js";
import { getBundledMarketplaceRecordSync } from "./official-marketplace.js";
import { isKnownMarketplaceRecord } from "./marketplace-manifest.js";
import { isRecord } from "./helpers.js";

export function loadKnownMarketplacesSync(storageRoot: string): KnownMarketplaceRecord[] {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE));
  const value = isRecord(parsed) ? parsed.marketplaces : undefined;
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  // 旧 known 中的官方 URL 和错误状态只属于已退休来源，不能成为隐式下载路径。
  return [
    getBundledMarketplaceRecordSync(storageRoot),
    ...entries
      .filter(isKnownMarketplaceRecord)
      .filter((record) => !isOfficialMarketplaceId(record.id)),
  ];
}

export async function stageMarketplaceDirectoryPlugins(
  sourceDir: string,
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  throwIfPluginOperationAborted(signal);
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    sourcePath: sourceDir,
    targetPath: targetDir,
  });
}

export async function stageMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  // URL/settings source 没有 sourceRoot；直接覆盖 manifest 时若写入期间
  // deadline 到达或 known state 落盘失败就无法回滚。prepare-only activation 让 manifest
  // 与 known_marketplaces.json 使用同一个 transactionId 提交，失败时继续读取上一代快照。
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    targetPath: targetDir,
  });
}

export async function upsertKnownMarketplace(
  storageRoot: string,
  record: KnownMarketplaceRecord,
): Promise<KnownMarketplaceActivation> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((item) => item.id === record.id);
  const previous = index >= 0 ? known[index] : undefined;
  if (index >= 0) {
    const {
      cacheTransactionId: _previousCacheTransactionId,
      lastRefreshFailure: _lastRefreshFailure,
      ...successfulPrevious
    } = previous ?? record;
    known[index] = {
      ...successfulPrevious,
      ...record,
      addedAt: previous?.addedAt ?? record.addedAt,
    };
  } else {
    known.push(record);
  }
  await writeKnownMarketplaces(storageRoot, known);
  let settled = false;
  return {
    finalize: () => {
      settled = true;
    },
    rollback: async () => {
      if (settled) return;
      const current = loadKnownMarketplacesSync(storageRoot);
      const currentIndex = current.findIndex((item) => item.id === record.id);
      const currentRecord = currentIndex >= 0 ? current[currentIndex] : undefined;
      if (
        !currentRecord ||
        currentRecord.lastUpdated !== record.lastUpdated ||
        currentRecord.cacheTransactionId !== record.cacheTransactionId
      ) {
        throw new Error(
          `Cannot roll back marketplace authority after concurrent update: ${record.id}`,
        );
      }
      if (previous) {
        current[currentIndex] = previous;
      } else {
        current.splice(currentIndex, 1);
      }
      await writeKnownMarketplaces(storageRoot, current);
      settled = true;
    },
  };
}

export async function persistMarketplaceRefreshFailure(
  storageRoot: string,
  marketplace: string,
  failure: MarketplaceRefreshFailure,
): Promise<void> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((record) => record.id === marketplace);
  if (index < 0 || !known[index]) return;
  known[index] = { ...known[index], lastRefreshFailure: failure };
  await writeKnownMarketplaces(storageRoot, known);
}

export async function writeKnownMarketplaces(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[],
): Promise<void> {
  await writeJsonFile(join(storageRoot, KNOWN_MARKETPLACES_FILE), {
    version: 1,
    marketplaces: marketplaces.filter((record) => !isOfficialMarketplaceId(record.id)),
  });
}
