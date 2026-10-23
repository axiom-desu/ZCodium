// ProjectionState —— ProductProjection 内部唯一可变状态容器。
//
// 约定（见 spec.lint-product-projection.md）：
// - `ProductProjection` 仍是唯一对外 receiver 与事件次序仲裁者，本文件不产生第二份事实；
// - 派生 reducer 只接收 `Pick<ProjectionState, ...>` 之类的窄端口，并原地写同一个实例；
// - clone/adopt 只在本文件实现一次，避免侧表遗漏（旧实现逐字段手抄 40 项）。
import type {
  ConversationSnapshot,
  CuaAppIdentity,
  HookInvocationRow,
  MutableConversationSnapshotAccumulator,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionEvent } from "@zcode/contracts";
import type { ConversationNormalizationDiagnostic } from "./event-normalizer.js";
import type {
  ContextWindowProjectionState,
  ConversationEditTarget,
} from "./product-projection-types.js";

export type HookInvocationRowContent = Omit<
  HookInvocationRow,
  | "actions"
  | "createdAt"
  | "createdAtSeq"
  | "entityId"
  | "productTurnId"
  | "rowId"
  | "turnId"
  | "visibility"
>;

export interface PendingSessionHookInvocation {
  firstEvent: SessionEvent;
  content: HookInvocationRowContent;
}

export interface FileToolInputPreviewState {
  lastPublishedAt: number | null;
  pendingAppend: string;
}

export type TurnModelBaseline =
  | { kind: "silentInitial" }
  | { kind: "sourceLess" }
  | { kind: "known"; provider: string; model: string; thought: string };

/**
 * 投影的全部可变状态。字段语义见各字段注释（已随字段迁移到本文件）。
 * 单一实例由 `ProductProjection` 持有；原子提交只替换该实例引用（见 applyEventAtomically）。
 */
export interface ProjectionState {
  snapshot: ConversationSnapshot;
  /** reducer 内部 rowId 查找；与 rows.window 同步，rewind 时重建。 */
  rowIndexById: Map<number, number>;
  hydrationAccumulator: MutableConversationSnapshotAccumulator | null;
  nextRowId: number;
  streamingTextRowId: number | null;
  streamingReasoningRowId: number | null;
  /** output-token Continue 的紧邻前一条 assistant 行；只在同 product turn 内复用。 */
  outputContinuationTextRowId: number | null;
  toolRowIdByCallId: Map<string, number>;
  latestListAppsSnapshot: Map<number, CuaAppIdentity>;
  /** 派生索引：TurnComplete 缺终态兜底时避免扫描全表。 */
  openForegroundToolCallIds: Set<string>;
  fileToolInputPreviewByCallId: Map<string, FileToolInputPreviewState>;
  subagentRowIdByAgentId: Map<string, number>;
  hookRowIdByInvocationId: Map<string, number>;
  /** resume SessionStart 没有 turnId；等下一条真实 user-intent 再分配 rowId。 */
  pendingSessionHookInvocations: Map<string, PendingSessionHookInvocation>;
  /** rewind 后迟到 terminal 的 invocation 墓碑。 */
  rewoundHookInvocationIds: Set<string>;
  /** 冷恢复 transcript 中 ghost child 的排除集合。 */
  invalidSubagentChildSessionIds: Set<string>;
  /** rowId → 权威 messageId 侧表（不进 row schema）。 */
  messageIdByRowId: Map<number, string>;
  outputContinuationRowIdByMessageId: Map<string, number>;
  entityIdByRowId: Map<number, string>;
  /** canonical command target 只按稳定实体身份寻址。 */
  editTargetByEntityId: Map<string, ConversationEditTarget>;
  currentEditableEntityId: string | null;
  stableCompactCoverageBoundaryRowId: number | null;
  turnHeaderRowIdByTurnId: Map<string, number>;
  compactMarkerRowIdByOperationId: Map<string, number>;
  goalVerifyMarkerRowIdByLifecycleKey: Map<string, number>;
  /** queue drain 切轮映射：runtimeTurnId → 最新 productTurnId。 */
  productTurnIdByRuntimeTurnId: Map<string, string>;
  runtimeTurnIdByProductTurnId: Map<string, string>;
  productTurnSplitOrdinalByRuntimeTurnId: Map<string, number>;
  currentProductTurnStartedAtMs: number | null;
  /** 投递语义侧表：guide 内联当前轮，queue 在 drain 时切轮。 */
  deliveryByPendingInputId: Map<string, "guide" | "queue">;
  currentTurnId: string | null;
  /** 当前 runtime turn 是否由 model-only TurnStarted 建立（维护 turn）。 */
  currentTurnStartedModelOnly: boolean;
  contextWindowState: ContextWindowProjectionState;
  lastTurnModel: TurnModelBaseline;
  /** 种子守卫：事件触碰过的 config 区块不再接受种子覆盖。 */
  configModelTouchedByEvent: boolean;
  configThoughtLevelsTouchedByEvent: boolean;
  configModeTouchedByEvent: boolean;
  /** assistant 守恒：非运行期拒收的正文流计数。 */
  droppedContentStreamEventCount: number;
  normalizationDiagnostics: ConversationNormalizationDiagnostic[];
}

export function createProjectionState(snapshot: ConversationSnapshot): ProjectionState {
  return {
    snapshot,
    rowIndexById: new Map<number, number>(),
    hydrationAccumulator: null,
    nextRowId: 1,
    streamingTextRowId: null,
    streamingReasoningRowId: null,
    outputContinuationTextRowId: null,
    toolRowIdByCallId: new Map<string, number>(),
    latestListAppsSnapshot: new Map<number, CuaAppIdentity>(),
    openForegroundToolCallIds: new Set<string>(),
    fileToolInputPreviewByCallId: new Map<string, FileToolInputPreviewState>(),
    subagentRowIdByAgentId: new Map<string, number>(),
    hookRowIdByInvocationId: new Map<string, number>(),
    pendingSessionHookInvocations: new Map<string, PendingSessionHookInvocation>(),
    rewoundHookInvocationIds: new Set<string>(),
    invalidSubagentChildSessionIds: new Set<string>(),
    messageIdByRowId: new Map<number, string>(),
    outputContinuationRowIdByMessageId: new Map<string, number>(),
    entityIdByRowId: new Map<number, string>(),
    editTargetByEntityId: new Map<string, ConversationEditTarget>(),
    currentEditableEntityId: null,
    stableCompactCoverageBoundaryRowId: null,
    turnHeaderRowIdByTurnId: new Map<string, number>(),
    compactMarkerRowIdByOperationId: new Map<string, number>(),
    goalVerifyMarkerRowIdByLifecycleKey: new Map<string, number>(),
    productTurnIdByRuntimeTurnId: new Map<string, string>(),
    runtimeTurnIdByProductTurnId: new Map<string, string>(),
    productTurnSplitOrdinalByRuntimeTurnId: new Map<string, number>(),
    currentProductTurnStartedAtMs: null,
    deliveryByPendingInputId: new Map<string, "guide" | "queue">(),
    currentTurnId: null,
    currentTurnStartedModelOnly: false,
    contextWindowState: { maxTokens: null, touchedByEvent: false, usedTokens: 0 },
    lastTurnModel: { kind: "silentInitial" },
    configModelTouchedByEvent: false,
    configThoughtLevelsTouchedByEvent: false,
    configModeTouchedByEvent: false,
    droppedContentStreamEventCount: 0,
    normalizationDiagnostics: [],
  };
}

/**
 * 深拷贝一份独立状态，供 applyEventAtomically 的候选投影使用。
 * 任何新增侧表/Set 必须在此登记，否则成功的候选提交会丢失该索引。
 */
export function cloneProjectionState(state: ProjectionState): ProjectionState {
  return {
    snapshot: state.snapshot,
    rowIndexById: new Map(state.rowIndexById),
    hydrationAccumulator: null,
    nextRowId: state.nextRowId,
    streamingTextRowId: state.streamingTextRowId,
    streamingReasoningRowId: state.streamingReasoningRowId,
    outputContinuationTextRowId: state.outputContinuationTextRowId,
    toolRowIdByCallId: new Map(state.toolRowIdByCallId),
    // 实时发布逐事件走原子 clone；遗漏该侧表会让成功的 list_apps 快照在提交时丢失。
    latestListAppsSnapshot: new Map(state.latestListAppsSnapshot),
    openForegroundToolCallIds: new Set(state.openForegroundToolCallIds),
    fileToolInputPreviewByCallId: new Map(
      [...state.fileToolInputPreviewByCallId].map(([toolCallId, preview]) => [
        toolCallId,
        { ...preview },
      ]),
    ),
    subagentRowIdByAgentId: new Map(state.subagentRowIdByAgentId),
    hookRowIdByInvocationId: new Map(state.hookRowIdByInvocationId),
    pendingSessionHookInvocations: new Map(
      [...state.pendingSessionHookInvocations].map(([invocationId, pending]) => [
        invocationId,
        {
          firstEvent: pending.firstEvent,
          content: {
            ...pending.content,
            executions: pending.content.executions.map((execution) => ({ ...execution })),
          },
        },
      ]),
    ),
    rewoundHookInvocationIds: new Set(state.rewoundHookInvocationIds),
    invalidSubagentChildSessionIds: new Set(state.invalidSubagentChildSessionIds),
    messageIdByRowId: new Map(state.messageIdByRowId),
    outputContinuationRowIdByMessageId: new Map(state.outputContinuationRowIdByMessageId),
    entityIdByRowId: new Map(state.entityIdByRowId),
    editTargetByEntityId: new Map(state.editTargetByEntityId),
    currentEditableEntityId: state.currentEditableEntityId,
    stableCompactCoverageBoundaryRowId: state.stableCompactCoverageBoundaryRowId,
    turnHeaderRowIdByTurnId: new Map(state.turnHeaderRowIdByTurnId),
    compactMarkerRowIdByOperationId: new Map(state.compactMarkerRowIdByOperationId),
    goalVerifyMarkerRowIdByLifecycleKey: new Map(state.goalVerifyMarkerRowIdByLifecycleKey),
    productTurnIdByRuntimeTurnId: new Map(state.productTurnIdByRuntimeTurnId),
    runtimeTurnIdByProductTurnId: new Map(state.runtimeTurnIdByProductTurnId),
    productTurnSplitOrdinalByRuntimeTurnId: new Map(state.productTurnSplitOrdinalByRuntimeTurnId),
    currentProductTurnStartedAtMs: state.currentProductTurnStartedAtMs,
    deliveryByPendingInputId: new Map(state.deliveryByPendingInputId),
    currentTurnId: state.currentTurnId,
    currentTurnStartedModelOnly: state.currentTurnStartedModelOnly,
    contextWindowState: { ...state.contextWindowState },
    lastTurnModel: { ...state.lastTurnModel },
    configModelTouchedByEvent: state.configModelTouchedByEvent,
    configThoughtLevelsTouchedByEvent: state.configThoughtLevelsTouchedByEvent,
    configModeTouchedByEvent: state.configModeTouchedByEvent,
    droppedContentStreamEventCount: state.droppedContentStreamEventCount,
    normalizationDiagnostics: [...state.normalizationDiagnostics],
  };
}

/** 行/事件读取原语：派生 reducer 与 class 共用，避免各自复制同一查找逻辑。 */
export function projectionMs(event: SessionEvent): number {
  return event.timestamp.getTime();
}

export function findProjectionRow(
  state: Pick<ProjectionState, "snapshot" | "rowIndexById">,
  rowId: number,
): ConversationSnapshot["rows"]["window"][number] | undefined {
  const index = state.rowIndexById.get(rowId);
  return index === undefined ? undefined : state.snapshot.rows.window[index];
}

export function projectionTurnIdOf(
  state: Pick<ProjectionState, "currentTurnId" | "productTurnIdByRuntimeTurnId">,
  event: SessionEvent,
): string {
  const runtimeTurnId = String(event.turnId ?? state.currentTurnId ?? "turn-unknown");
  // queue drain 切轮后，同一 runtimeTurn 的后续事件行归入最新 productTurn。
  return state.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
}

export function appendProjectionRowBase(
  state: Pick<ProjectionState, "nextRowId" | "entityIdByRowId">,
  event: SessionEvent,
  turnId: string,
  entityId: string = String(event.id),
) {
  const rowId = state.nextRowId++;
  state.entityIdByRowId.set(rowId, entityId);
  return {
    rowId,
    turnId,
    entityId,
    productTurnId: turnId,
    visibility: "visible" as const,
    createdAt: projectionMs(event),
    createdAtSeq: event.sequenceNumber,
  };
}

export function isProjectionRunning(state: Pick<ProjectionState, "snapshot">): boolean {
  const phase = state.snapshot.control.phase;
  return phase === "running" || phase === "prewarming";
}
