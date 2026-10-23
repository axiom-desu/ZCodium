import type { CompactLifecyclePayload, SessionEvent } from "@zcode/contracts";
import type { ProjectionState } from "./product-projection-state.js";
import type {
  ConversationDelta,
  TimelineMarkerPayload,
  TimelineMarkerRow,
} from "@zcode/shared/zcode-protocol-v4";
import { mapCompactMarkerOrigin, mapCompactMarkerStatus } from "./projection-rows.js";
import {
  controlPatch,
  findRow,
  ms,
  rowBase,
  rowIdForMessageId,
  turnIdOf,
} from "./product-projection-primitives.js";

// ── compact marker（compact 命令效果）──
// 同一 operationId 全生命周期占同一 marker row：running → success/failed/noop/cancelled。
// 归属：marker 落在事件到达时的行尾，客户端零归属逻辑。

export function onCompactLifecycle(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as CompactLifecyclePayload & {
    anchorMessageId?: string;
    tailStartMessageId?: string;
  };
  const existingRowId = state.compactMarkerRowIdByOperationId.get(payload.operationId);
  const existingRow = existingRowId !== undefined ? findRow(state, existingRowId) : undefined;
  const prev =
    existingRow?.kind === "timelineMarker" && existingRow.marker.type === "compact"
      ? existingRow.marker
      : undefined;

  const status = mapCompactMarkerStatus(payload.status);
  if (status === "success") {
    const coverageMessageId = payload.tailStartMessageId ?? payload.anchorMessageId;
    const coverageRowId = coverageMessageId ? rowIdForMessageId(state, coverageMessageId) : null;
    if (coverageRowId !== null) {
      state.stableCompactCoverageBoundaryRowId = Math.max(
        state.stableCompactCoverageBoundaryRowId ?? 0,
        coverageRowId,
      );
      for (const [rowId, entityId] of state.entityIdByRowId) {
        if (rowId > state.stableCompactCoverageBoundaryRowId) continue;
        const target = state.editTargetByEntityId.get(entityId);
        if (target && !target.coveredByStableCompact) {
          state.editTargetByEntityId.set(entityId, {
            ...target,
            coveredByStableCompact: true,
          });
        }
      }
    }
  }
  const tokensAfter =
    payload.truePostCompactTokenCount ?? payload.postCompactTokenCount ?? prev?.tokensAfter;
  const marker: TimelineMarkerPayload = {
    type: "compact",
    origin: prev?.origin ?? mapCompactMarkerOrigin(payload.trigger),
    status,
    // 终态事件才带 token 计数；upsert 时保留已知值（retry 不清零）。
    ...(payload.preCompactTokenCount !== undefined || prev?.tokensBefore !== undefined
      ? { tokensBefore: payload.preCompactTokenCount ?? prev?.tokensBefore }
      : {}),
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    // summary 全文按 ref 拉（同 toolOutput/get）；以 summaryMessageId 占位。
    ...(payload.summaryMessageId !== undefined || prev?.summaryRef
      ? {
          summaryRef:
            payload.summaryMessageId !== undefined
              ? String(payload.summaryMessageId)
              : prev?.summaryRef,
        }
      : {}),
  };

  const deltas: ConversationDelta[] = [];
  if (existingRow?.kind === "timelineMarker") {
    deltas.push({
      op: "row.upserted",
      row: {
        ...existingRow,
        marker,
        ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
      },
    });
  } else {
    const row: TimelineMarkerRow = {
      ...rowBase(state, event, turnIdOf(state, event), String(payload.operationId)),
      kind: "timelineMarker",
      lane: "assistantWork",
      marker,
      ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
    };
    state.compactMarkerRowIdByOperationId.set(payload.operationId, row.rowId);
    deltas.push({ op: "row.appended", row });
  }

  // compacting 进出 activeWorks（guard 同源派生：compactOperationLock /
  // compactingAcceptsFutureInput 由此驱动，与 formal-proof evaluateCompacting 对齐）。
  const otherWorks = state.snapshot.control.activeWorks.filter((work) => work.kind !== "compact");
  if (status === "running") {
    deltas.push({
      op: "state.updated",
      patch: controlPatch(state, {
        activeWorks: [...otherWorks, { kind: "compact", startedAt: ms(event) }],
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: otherWorks.length > 0 ? "mixed" : "compact",
      }),
    });
  } else {
    deltas.push({
      op: "state.updated",
      patch: controlPatch(state, {
        activeWorks: otherWorks,
        ...(otherWorks.length === 0
          ? {
              canStop: false,
              stopState: "idle" as const,
              stopTargetKind: "unknown" as const,
            }
          : {}),
      }),
    });
  }

  // compact 成功 → context 水位立即回落（usage.contextWindow 更新）。
  if (status === "success" && tokensAfter !== undefined) {
    state.contextWindowState.usedTokens = tokensAfter;
    const maxTokens =
      state.snapshot.usage.contextWindow?.maxTokens ?? state.contextWindowState.maxTokens;
    deltas.push({
      op: "state.updated",
      patch: {
        usage: {
          ...state.snapshot.usage,
          contextWindow:
            maxTokens === null
              ? null
              : {
                  usedTokens: tokensAfter,
                  maxTokens,
                  autoCompactThresholdTokens:
                    state.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                },
        },
      },
    });
  }
  return deltas;
}
