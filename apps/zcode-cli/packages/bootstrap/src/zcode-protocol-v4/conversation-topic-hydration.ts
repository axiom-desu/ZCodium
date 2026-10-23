import { Buffer } from "node:buffer";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { PROTOCOL_V4_LIMITS, type ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";

/**
 * cold replay 会高频测量临时 delta；TextEncoder 会为每次测量再分配完整 Uint8Array。
 * CLI 已固定运行在 Node，这里对同一 JSON 文本直接计算精确 UTF-8 字节数，不做近似估算。
 */
function coldHydrationJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

// 运行中正文必须给 TurnError/TurnComplete 的 bounded terminal patch 留出空间；否则正文
// 恰好占满 16MiB 后，停止 turn 的终态本身也无法进入可传输 snapshot。
const PROJECTION_TERMINAL_RESERVE_BYTES = 64 * 1024;

// row.actions 的 schema 只有 4 个 true 布尔值和一个短枚举；含 JSON key/父级包装不足
// 128 bytes。批量 checkpoint 之间按 wire tail 的每行完整预留，保证延迟 materialize
// 不会让 payload 上界低估。
const HYDRATION_ACTION_BYTES_PER_WIRE_ROW = 128;
const HYDRATION_EVENT_WIRE_OVERHEAD_BYTES = 64;
// logical snapshot frame 中 sequence number 同时出现在 frame.toSeq 与 snapshot.seq。
const HYDRATION_SEQUENCE_NUMBER_OCCURRENCES = 2;

function hydrationSequenceNumberBytes(sequenceNumber: number): number {
  return String(sequenceNumber).length * HYDRATION_SEQUENCE_NUMBER_OCCURRENCES;
}

export function projectionLimitForEvent(event: SessionEvent): number {
  return event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
    ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
    : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
}

interface BatchHydrationContext {
  projection: ProductProjection;
  getWireSnapshot(snapshot?: ConversationSnapshot): ConversationSnapshot;
  measureWireSnapshotBytes(snapshot: ConversationSnapshot): number;
  wireSnapshotBytesUpperBound: number;
}

interface BatchHydrationResult {
  ok: boolean;
  wireSnapshotBytesUpperBound: number;
}

/**
 * 冷恢复快路径：只修改尚未发布的 candidate。协议 wire snapshot 固定只含末尾 60 行，
 * 因此 row 更新只累计仍在 tail 的 delta，再给尚未 materialize 的 actions 按行预留
 * 完整 schema 上界；已滑出 tail 的保守增长在触及 payload limit 时通过精确测量消除。
 * 最终只做一次全行 actions 收敛，整体成本随事件/行数线性增长。
 */
export function tryBatchHydration(
  context: BatchHydrationContext,
  events: readonly SessionEvent[],
): BatchHydrationResult {
  context.projection.beginHydrationReplay();
  let measuredBytes = context.wireSnapshotBytesUpperBound;
  let measuredSequenceNumberBytes = hydrationSequenceNumberBytes(
    context.projection.getSnapshot().seq,
  );
  let encodedGrowthSinceMeasurement = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const deltas = context.projection.applyHydrationEvent(event);
    const finalEvent = index === events.length - 1;
    const projectionLimit = projectionLimitForEvent(event);
    const mustMeasureSnapshot = finalEvent || deltas.some((delta) => delta.op === "row.removed");

    if (finalEvent) context.projection.completeHydrationReplay();
    const snapshot = context.projection.getSnapshot();
    if (!mustMeasureSnapshot && deltas.length > 0) {
      let wireRowIds: Set<number> | undefined;
      const wireDeltas = deltas.filter((delta) => {
        if (delta.op === "state.updated" || delta.op === "row.appended") return true;
        if (delta.op === "row.removed")
          return { ok: false, wireSnapshotBytesUpperBound: context.wireSnapshotBytesUpperBound };
        // 4b-2：插件资源通知只走实时增量，不进冷启动测量。
        if (
          delta.op === "pluginUi.resourceUpdated" ||
          delta.op === "pluginUi.resourceListChanged" ||
          delta.op === "pluginUi.appToolCall" ||
          delta.op === "pluginUi.instanceClosed"
        )
          return { ok: false, wireSnapshotBytesUpperBound: context.wireSnapshotBytesUpperBound };
        // 键级增量作用在状态键上，不在 60 行 wire tail 里——没有「已滑出窗口所以不计」这一说，
        // 与 state.updated 同规一律计入。
        if (delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed") return true;
        wireRowIds ??= new Set(
          snapshot.rows.window
            .slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
            .map((row) => row.rowId),
        );
        const rowId = delta.op === "row.upserted" ? delta.row.rowId : delta.rowId;
        return wireRowIds.has(rowId);
      });
      if (wireDeltas.length > 0) {
        encodedGrowthSinceMeasurement +=
          coldHydrationJsonByteLength({ kind: "deltas", deltas: wireDeltas }) +
          HYDRATION_EVENT_WIRE_OVERHEAD_BYTES;
      }
    }

    const actionBytesUpperBound = finalEvent
      ? 0
      : Math.min(snapshot.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows) *
        HYDRATION_ACTION_BYTES_PER_WIRE_ROW;
    const currentSequenceNumberBytes = hydrationSequenceNumberBytes(snapshot.seq);
    const sequenceNumberGrowth = Math.max(
      0,
      currentSequenceNumberBytes - measuredSequenceNumberBytes,
    );
    let upperBound =
      measuredBytes + encodedGrowthSinceMeasurement + sequenceNumberGrowth + actionBytesUpperBound;
    if (mustMeasureSnapshot || upperBound > projectionLimit) {
      // 保守 delta 累计值一旦超限就直接回退 strict 的话，重复 upsert
      // 即使未增大 snapshot 也会误回退；固定 32-event 重测还会反复序列化 checkpoint。
      measuredBytes = context.measureWireSnapshotBytes(context.getWireSnapshot());
      measuredSequenceNumberBytes = currentSequenceNumberBytes;
      encodedGrowthSinceMeasurement = 0;
      upperBound = measuredBytes + actionBytesUpperBound;
    }
    if (upperBound > projectionLimit) {
      return {
        ok: false,
        wireSnapshotBytesUpperBound: context.wireSnapshotBytesUpperBound,
      };
    }
  }

  if (events.length === 0) {
    context.projection.completeHydrationReplay();
    measuredBytes = context.measureWireSnapshotBytes(context.getWireSnapshot());
  }
  return { ok: true, wireSnapshotBytesUpperBound: measuredBytes };
}
