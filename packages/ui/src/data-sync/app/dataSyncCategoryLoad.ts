import type { IServiceAccessor } from "@zcode/services";
import type { DataSyncWorkspaceMapping } from "@zcode/shared";
import {
  compareDataSyncItems,
  selectDataSyncHashRequests,
  type DataSyncRow,
} from "../domain/compareRows.js";
import type { DataSyncCategoryAdapter } from "./categories.js";
import { dataSyncErrorMessage, isDataSyncUnsupportedError } from "./dataSyncErrors.js";
import {
  readDataSyncHashCache,
  writeDataSyncHashCache,
  type DataSyncHashCache,
} from "./dataSyncHashCache.js";

type DataSyncCategoryLoadResult =
  | { kind: "stale" }
  | { kind: "unsupported" }
  | { kind: "error"; error: string }
  | {
      kind: "ready";
      rows: DataSyncRow[];
      localCount: number;
      remoteCount: number;
      sourceKeys: ReadonlySet<string>;
      targetKeys: ReadonlySet<string>;
    };

/**
 * 一个分类的完整读取：两端并行 list → 只对两端都有且可比对的项取哈希 → 生成行。
 * 纯异步流程，不落 React 状态；`isCurrent` 为 false（generation 换代的迟到结果）时丢弃。
 *
 * 旧 Server 缺五方法 / `user-config-sync` 时返回 `unsupported`，不能当作空列表成功。
 */
export async function loadDataSyncCategory(params: {
  category: DataSyncCategoryAdapter;
  sourceServices: IServiceAccessor;
  targetServices: IServiceAccessor;
  workspace?: DataSyncWorkspaceMapping;
  sourceCache: DataSyncHashCache;
  targetCache: DataSyncHashCache;
  isCurrent(): boolean;
}): Promise<DataSyncCategoryLoadResult> {
  const { category, sourceServices, targetServices, workspace } = params;
  const sourceService = category.getService(sourceServices);
  const targetService = category.getService(targetServices);
  let sourceList: Awaited<ReturnType<typeof sourceService.listSyncItems>>;
  let targetList: Awaited<ReturnType<typeof targetService.listSyncItems>>;
  try {
    // 两端并行（性能措施 4）；概览按分类逐行显示加载状态。
    [sourceList, targetList] = await Promise.all([
      sourceService.listSyncItems(),
      targetService.listSyncItems(),
    ]);
  } catch (error) {
    if (!params.isCurrent()) return { kind: "stale" };
    if (isDataSyncUnsupportedError(error)) return { kind: "unsupported" };
    return { kind: "error", error: dataSyncErrorMessage(error) };
  }
  if (!params.isCurrent()) return { kind: "stale" };

  const requests = selectDataSyncHashRequests(
    sourceList.items,
    targetList.items,
    targetList.importBlockedReason,
  );
  const sourceCached = readDataSyncHashCache(
    params.sourceCache,
    sourceList.items,
    requests.sourceKeys,
  );
  const targetCached = readDataSyncHashCache(
    params.targetCache,
    targetList.items,
    requests.targetKeys,
  );

  let sourceHashes: Record<string, string> = {};
  let targetHashes: Record<string, string> = {};
  try {
    const results = await Promise.all([
      sourceCached.missing.length > 0
        ? // 来源端带上目标端 home：需要路径改写的分类（MCP）按目标端路径计算后再比较。
          sourceService.getSyncContentHashes({
            keys: sourceCached.missing,
            targetHomeDir: targetList.homeDir,
            ...(workspace ? { workspace } : {}),
          })
        : Promise.resolve({ hashes: {} }),
      targetCached.missing.length > 0
        ? targetService.getSyncContentHashes({ keys: targetCached.missing })
        : Promise.resolve({ hashes: {} }),
    ]);
    sourceHashes = results[0].hashes;
    targetHashes = results[1].hashes;
  } catch (error) {
    if (!params.isCurrent()) return { kind: "stale" };
    if (isDataSyncUnsupportedError(error)) return { kind: "unsupported" };
    return { kind: "error", error: dataSyncErrorMessage(error) };
  }
  if (!params.isCurrent()) return { kind: "stale" };

  writeDataSyncHashCache(params.sourceCache, sourceList.items, sourceHashes);
  writeDataSyncHashCache(params.targetCache, targetList.items, targetHashes);
  const rows = compareDataSyncItems({
    sourceItems: sourceList.items,
    targetItems: targetList.items,
    sourceHashes: { ...sourceCached.hashes, ...sourceHashes },
    targetHashes: { ...targetCached.hashes, ...targetHashes },
    targetBlockedReason: targetList.importBlockedReason,
  });
  return {
    kind: "ready",
    rows,
    localCount: sourceList.items.length,
    remoteCount: targetList.items.length,
    sourceKeys: new Set(sourceList.items.map((item) => item.key)),
    targetKeys: new Set(targetList.items.map((item) => item.key)),
  };
}
