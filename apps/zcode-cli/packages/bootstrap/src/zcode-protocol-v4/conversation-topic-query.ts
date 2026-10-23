import type {
  CommandEnvelope,
  ConversationDelta,
  ConversationSnapshot,
  DeliveryProfile,
  DeliveryProfileName,
  QueueItem,
  ToolCallRow,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  clampWorkflowRunsForLegacy,
  filterConversationDeltasForProfile,
  filterConversationRowsForProfile,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "./product-projection.js";
import { encodeConversationDeltasForLegacy } from "./conversation-workflow-run-deltas.js";

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPlanMarkdown(row: ToolCallRow): boolean {
  if (isRecord(row.input)) {
    const plan = row.input.plan;
    if (typeof plan === "string" && plan.trim().length > 0) return true;
  }
  if (!row.inputText.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(row.inputText);
    return isRecord(parsed) && typeof parsed.plan === "string" && parsed.plan.trim().length > 0;
  } catch {
    return false;
  }
}

export function getRowsRange(
  projection: ProductProjection,
  logEpoch: string,
  params: { beforeRowId?: number; limit: number },
  deliveryProfile: DeliveryProfileName = "replayable",
): V4ConversationRowsRangeResult {
  const snapshot = projection.getSnapshot();
  const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
  const visibleRows = filterConversationRowsForProfile(
    snapshot.rows.window,
    DELIVERY_PROFILES[deliveryProfile],
  );
  const eligible =
    params.beforeRowId === undefined
      ? visibleRows
      : visibleRows.filter((row) => row.rowId < (params.beforeRowId as number));
  const rows = eligible.slice(-limit);
  return {
    rows,
    atSeq: snapshot.seq,
    atRevision: snapshot.revision,
    atLogEpoch: logEpoch,
    hasMore: eligible.length > rows.length,
  };
}

export function getPlans(
  projection: ProductProjection,
  logEpoch: string,
): V4ConversationPlansResult {
  const snapshot = projection.getSnapshot();
  const plans = snapshot.rows.window
    .filter(
      (row): row is ToolCallRow =>
        row.kind === "toolCall" &&
        row.toolName === "ExitPlanMode" &&
        TERMINAL_PLAN_STATUSES.has(row.status) &&
        hasPlanMarkdown(row),
    )
    .toSorted((left, right) => right.rowId - left.rowId);
  return {
    plans,
    atSeq: snapshot.seq,
    atLogEpoch: logEpoch,
  };
}

export function wireSnapshotForProfile(
  snapshot: ConversationSnapshot,
  profile: DeliveryProfile,
): ConversationSnapshot {
  const visibleRows = filterConversationRowsForProfile(snapshot.rows.window, profile);
  const visibleSnapshot: ConversationSnapshot = {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      window: visibleRows,
      totalCount: visibleRows.length,
      firstRowId: visibleRows[0]?.rowId ?? null,
    },
  };
  const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  if (visibleRows.length <= limit) return visibleSnapshot;
  return {
    ...visibleSnapshot,
    rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-limit) },
  };
}

export function wireSnapshotForSubscription(
  snapshot: ConversationSnapshot,
  profile: DeliveryProfile,
  workflowRunDeltas: boolean,
): ConversationSnapshot {
  const visibleSnapshot = wireSnapshotForProfile(snapshot, profile);
  if (workflowRunDeltas || visibleSnapshot.workflowRuns === undefined) return visibleSnapshot;
  const workflowRuns = clampWorkflowRunsForLegacy(visibleSnapshot.workflowRuns);
  return workflowRuns === visibleSnapshot.workflowRuns
    ? visibleSnapshot
    : { ...visibleSnapshot, workflowRuns };
}

export function encodeDeltasForSubscription(
  deltas: readonly ConversationDelta[],
  profile: DeliveryProfile,
  workflowRunDeltas: boolean,
  workflowRuns: ConversationSnapshot["workflowRuns"],
): readonly ConversationDelta[] {
  const filtered = filterConversationDeltasForProfile(deltas, profile);
  if (workflowRunDeltas) return filtered;
  return encodeConversationDeltasForLegacy(filtered, workflowRuns);
}

export function measureWireSnapshotBytes(
  topic: string,
  logEpoch: string,
  snapshot: ConversationSnapshot,
): number {
  const frame = {
    topic,
    subscriptionId: `sub-${logEpoch}-${Number.MAX_SAFE_INTEGER}`,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: Number.MAX_SAFE_INTEGER,
    payload: { kind: "snapshot" as const, snapshot },
  };
  return utf8JsonByteLength(frame);
}

export function measureInputAdmissionProjectionBytes(input: {
  projection: ProductProjection;
  topic: string;
  logEpoch: string;
  envelope: CommandEnvelope;
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string };
}): number | null {
  const { envelope, admission } = input;
  const raw = envelope.payload as {
    text?: string;
    displayText?: string;
    attachments?: QueueItem["attachments"];
    firstInput?: { text: string; attachments?: QueueItem["attachments"] };
  };
  const prompt = envelope.type === "createSession" ? raw.firstInput : raw;
  if (
    !prompt ||
    (envelope.type !== "createSession" &&
      envelope.type !== "sendText" &&
      envelope.type !== "sendGoalCommand" &&
      envelope.type !== "compact")
  ) {
    return null;
  }
  const snapshot = input.projection.getSnapshot();
  const queueItem: QueueItem = {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind:
      envelope.type === "compact"
        ? "compact"
        : envelope.type === "sendGoalCommand"
          ? "sendGoalCommand"
          : "sendText",
    text:
      envelope.type === "compact"
        ? "/compact"
        : envelope.type === "sendGoalCommand"
          ? raw.displayText?.trim() || `/goal ${(prompt.text ?? "").trim()}`
          : (prompt.text ?? ""),
    attachments: prompt.attachments ?? [],
    delivery: { requested: "queue", admitted: "queue" },
    order: {
      admissionSeq: admission.admissionSeq,
      queuePosition: snapshot.queue.items.length,
    },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: admission.admittedAt,
  };
  const candidate: ConversationSnapshot = {
    ...snapshot,
    queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
  };
  return measureWireSnapshotBytes(
    input.topic,
    input.logEpoch,
    wireSnapshotForProfile(candidate, DELIVERY_PROFILES.continuous),
  );
}
