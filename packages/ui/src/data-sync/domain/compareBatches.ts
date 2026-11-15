import type { DeviceSyncResult } from "@zcode/shared";
import type { DataSyncRow } from "./compareRows.js";

type DataSyncCheckState = boolean | "indeterminate";

/** 分类三态：全部可勾选项已选 / 部分 / 未选。 */
export function resolveDataSyncCheckState(
  rows: readonly DataSyncRow[],
  selected: ReadonlySet<string>,
): DataSyncCheckState {
  const selectable = rows.filter((row) => row.selectable);
  const count = selectable.filter((row) => selected.has(row.key)).length;
  if (count === 0) return false;
  return count === selectable.length ? true : "indeterminate";
}

/**
 * 按「最上层的已选上级」分组：沿 parentKey 链向上走（链上未选中的中间项也穿过），
 * 取链上最上层的已选项作为组头。组内按层级排序，上级在前；组的字节取组头的字节（父目录已包含子目录）。
 */
function groupRowsByTopSelectedAncestor(
  rows: readonly DataSyncRow[],
  allRows: readonly DataSyncRow[],
): Array<{ rows: DataSyncRow[]; totalBytes: number }> {
  const parentByKey = new Map(allRows.map((row) => [row.key, row.parentKey]));
  const selectedByKey = new Map(rows.map((row) => [row.key, row]));
  const groups = new Map<string, { head: DataSyncRow; members: Array<[DataSyncRow, number]> }>();
  for (const row of rows) {
    let head = row;
    let depth = 0;
    let depthToHead = 0;
    const visited = new Set([row.key]);
    for (
      let cursor = parentByKey.get(row.key);
      cursor && !visited.has(cursor);
      cursor = parentByKey.get(cursor)
    ) {
      visited.add(cursor);
      depth += 1;
      const ancestor = selectedByKey.get(cursor);
      if (ancestor) {
        head = ancestor;
        depthToHead = depth;
      }
    }
    let group = groups.get(head.key);
    if (!group) {
      group = { head, members: [] };
      groups.set(head.key, group);
    }
    group.members.push([row, depthToHead]);
  }
  return [...groups.values()].map(({ head, members }) => ({
    rows: members.sort((left, right) => left[1] - right[1]).map(([member]) => member),
    totalBytes: head.totalBytes,
  }));
}

/**
 * 按来源字节数分批，单批不超过上限；单项上限由服务端标为不能同步，这里不再拆分。
 *
 * 父子技能同时选中时先按最上层已选上级分组：子技能与父技能放进同一批、上级在前，
 * 避免先导入的子技能在目标端建出父目录，父技能随后写入非空目录失败。
 * `allRows` 用于穿过未选中的中间上级。
 */
export function chunkDataSyncRows(
  rows: readonly DataSyncRow[],
  maxBatchBytes: number | undefined,
  allRows: readonly DataSyncRow[] = rows,
): DataSyncRow[][] {
  const groups = groupRowsByTopSelectedAncestor(rows, allRows);
  if (!maxBatchBytes) return rows.length > 0 ? [groups.flatMap((group) => group.rows)] : [];
  const batches: DataSyncRow[][] = [];
  let current: DataSyncRow[] = [];
  let currentBytes = 0;
  for (const group of groups) {
    if (current.length > 0 && currentBytes + group.totalBytes > maxBatchBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(...group.rows);
    currentBytes += group.totalBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 汇总一次推送（单个分类或推送全部）的结果，写入设备同步状态。 */
export function aggregateDeviceSyncResult(
  outcomes: ReadonlyArray<{ succeeded: number; failed: number }>,
): DeviceSyncResult {
  const succeeded = outcomes.reduce((total, outcome) => total + outcome.succeeded, 0);
  const failed = outcomes.reduce((total, outcome) => total + outcome.failed, 0);
  if (failed === 0) return "success";
  return succeeded === 0 ? "failed" : "partial";
}
