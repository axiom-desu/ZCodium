import type { IServiceAccessor } from "@zcode/services";
import type {
  DataSyncImportItem,
  DataSyncImportResultItem,
  DataSyncWorkspaceMapping,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { chunkDataSyncRows } from "../domain/compareBatches.js";
import type { DataSyncRow } from "../domain/compareRows.js";
import type { DataSyncCategoryAdapter } from "./categories.js";
import {
  DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR,
  DATA_SYNC_PREFLIGHT_TIMEOUT_MS,
  StalePushError,
  dataSyncErrorMessage,
  withDataSyncTimeout,
} from "./dataSyncErrors.js";
import type { DataSyncPushControl } from "./pluginCategorySync.js";
import type { DataSyncItemError, DataSyncPushOutcome } from "./types.js";

interface DataSyncCategoryPushResult extends DataSyncPushOutcome {
  itemErrors: Record<string, DataSyncItemError>;
}

function toImportItem(row: DataSyncRow): DataSyncImportItem {
  return {
    key: row.key,
    mode: row.importMode ?? "createOnly",
    ...(row.expectedTargetHash ? { expectedTargetHash: row.expectedTargetHash } : {}),
  };
}

/**
 * 一次分类推送：预检 → 按批导出 / 导入（CAS）→ 汇总逐项结果。
 *
 * - 同批后一批抛错时，前面批次已写入的结果必须保留：批内异常只把该批各项记为失败，继续下一批。
 * - 旧 push session 的异常/结果按 `assertAlive` 外抛，调用方丢弃，不覆盖新 session。
 * - 预检失败与非批次异常直接抛出，由调用方按分类整体失败处理。
 */
export async function pushDataSyncCategory(params: {
  category: DataSyncCategoryAdapter;
  sourceServices: IServiceAccessor;
  targetServices: IServiceAccessor;
  workspace?: DataSyncWorkspaceMapping;
  /** 已勾选且可勾选的行。 */
  rows: readonly DataSyncRow[];
  /** 分类全部行（分批时穿过未选中的父级）。 */
  allRows: readonly DataSyncRow[];
  control: DataSyncPushControl;
  /** session 已换代时抛出 StalePushError。 */
  assertAlive(): void;
}): Promise<DataSyncCategoryPushResult> {
  const { category, rows, allRows, control } = params;
  const sourceService = category.getService(params.sourceServices);
  const targetService = category.getService(params.targetServices, control);
  const workspace = params.workspace;
  const workspaceParam = workspace ? { workspace } : {};

  const access = await withDataSyncTimeout(
    targetService.checkSyncWriteAccess(),
    DATA_SYNC_PREFLIGHT_TIMEOUT_MS,
  );
  params.assertAlive();
  if (!access.ok) {
    throw new Error(access.error ? `${access.path}: ${access.error}` : access.path);
  }

  const results: DataSyncImportResultItem[] = [];
  // 同一分类按批次串行导出、导入；目标端每批一次导入。父子技能同时选中时同批、上级在前。
  for (const batch of chunkDataSyncRows(rows, category.maxBatchBytes, allRows)) {
    try {
      const payload = await sourceService.exportSyncItems({
        keys: batch.map((row) => row.key),
        ...workspaceParam,
      });
      params.assertAlive();
      const imported = await targetService.importSyncItems({
        payload,
        items: batch.map(toImportItem),
      });
      params.assertAlive();
      results.push(...imported.results);
    } catch (error) {
      if (error instanceof StalePushError) throw error;
      // assertAlive 已在上面抛出 StalePushError；这里的异常只属于该批。
      const message =
        error instanceof Error && error.message === DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR
          ? DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR
          : dataSyncErrorMessage(error);
      logger.warn("[DataSync] 批次推送失败", {
        category: category.id,
        keys: batch.map((row) => row.key),
        error: message,
      });
      for (const row of batch) results.push({ key: row.key, status: "failed", error: message });
    }
  }

  const resultByKey = new Map(results.map((result) => [result.key, result]));
  const itemErrors: Record<string, DataSyncItemError> = {};
  let succeeded = 0;
  for (const row of rows) {
    const result = resultByKey.get(row.key);
    if (result && result.status !== "failed" && result.status !== "conflict") {
      succeeded += 1;
    } else {
      itemErrors[row.key] = {
        status: result?.status === "conflict" ? "conflict" : "failed",
        ...(result?.error ? { message: result.error } : {}),
      };
    }
  }
  return { succeeded, failed: rows.length - succeeded, itemErrors };
}
