import type { ProjectionState } from "./product-projection-state.js";
import type { ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
  StableForkCandidateResolution,
} from "./product-projection-types.js";
import { findRow } from "./product-projection-primitives.js";

/**
 * rowId → 权威 messageId。桥接层执行 forkAssistant/editUserQuery 时把命令载荷的
 * 内部 rowId 翻译成 core 需要的 messageId。未知 rowId（非 assistant/user 行、
 * 或迟到）返回 null，桥接层据此回 rejected。
 */
export function getMessageIdForRowImpl(
  state: Pick<ProjectionState, "messageIdByRowId">,
  rowId: number,
): string | null {
  return state.messageIdByRowId.get(rowId) ?? null;
}

export function getEntityIdForRowImpl(
  state: Pick<ProjectionState, "entityIdByRowId">,
  rowId: number,
): string | null {
  return state.entityIdByRowId.get(rowId) ?? null;
}

export function resolveEditTargetImpl(
  state: ProjectionState,
  rowId: number,
): ConversationEditTarget | null {
  if (!isLatestEditableUserRowImpl(state, rowId)) return null;
  const entityId = state.entityIdByRowId.get(rowId);
  return entityId ? resolveEditTargetByEntityIdImpl(state, entityId) : null;
}

export function resolveEditTargetByEntityIdImpl(
  state: Pick<ProjectionState, "currentEditableEntityId" | "editTargetByEntityId">,
  entityId: string,
): ConversationEditTarget | null {
  if (entityId !== state.currentEditableEntityId) return null;
  const target = state.editTargetByEntityId.get(entityId);
  return target ? { ...target, intent: { ...target.intent } } : null;
}

/**
 * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
 * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
 * 不得再各自按位置、phase 或文本重算。
 */
export function resolveRowActionTargetImpl(
  state: ProjectionState,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution {
  const row = findRow(state, target.rowId);
  if (!row || state.entityIdByRowId.get(target.rowId) !== target.entityId) {
    return { ok: false, status: "stale", reasonCode: "proto.staleTarget" };
  }
  if (action === "editUserQuery") {
    const editTarget = resolveEditTargetByEntityIdImpl(state, target.entityId);
    if (row.actions?.canEdit !== true || !row.actions.editDisposition || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, editTarget };
  }
  if (action === "retryTurn") {
    const messageId = state.messageIdByRowId.get(row.rowId);
    const userRow = state.snapshot.rows.window.find(
      (candidate) =>
        candidate.turnId === row.turnId &&
        candidate.kind === "userInput" &&
        candidate.origin === "realUser",
    );
    const userEntityId = userRow ? state.entityIdByRowId.get(userRow.rowId) : undefined;
    const editTarget = userEntityId ? state.editTargetByEntityId.get(userEntityId) : undefined;
    if (row.actions?.canRetry !== true || !messageId || !editTarget) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId, editTarget };
  }
  if (action === "forkAssistant") {
    const messageId = state.messageIdByRowId.get(row.rowId);
    if (row.actions?.canFork !== true || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (action === "setAssistantFeedback") {
    const messageId = state.messageIdByRowId.get(row.rowId);
    if (row.kind !== "assistantText" || !messageId) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return { ok: true, action, row, messageId };
  }
  if (row.kind !== "turnHeader") {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  if (
    (action === "applyFileRewind" || action === "fileRewindPreview") &&
    (!row.fileChanges || row.actions?.canRewindFiles !== true)
  ) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.actionUnavailable",
    };
  }
  return {
    ok: true,
    action,
    row,
    messageIds: getMessageIdsForTurnRowImpl(state, row.rowId),
  };
}

/**
 * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
 * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
 */
export function getMessageIdsForTurnRowImpl(state: ProjectionState, rowId: number): string[] {
  const row = findRow(state, rowId);
  if (!row) return [];
  const messageIds = new Set<string>();
  const runtimeTurnId = state.runtimeTurnIdByProductTurnId.get(row.turnId);
  // Bug 原因：model-only turn 不生成可见 userInput row，过去只扫描 row 会漏掉
  // checkpoint 使用的隐藏 user messageId。新 turn 有持久消息时 productTurnId
  // 就是该 messageId；把它作为精确锚点后无需扩大 runtime turn 的兜底范围。
  if (runtimeTurnId && runtimeTurnId !== row.turnId) {
    messageIds.add(row.turnId);
  }
  for (const candidate of state.snapshot.rows.window) {
    if (candidate.turnId !== row.turnId) continue;
    const messageId = state.messageIdByRowId.get(candidate.rowId);
    if (messageId) messageIds.add(messageId);
  }
  for (const [messageId, continuationRowId] of state.outputContinuationRowIdByMessageId) {
    const continuationRow = findRow(state, continuationRowId);
    if (continuationRow?.turnId === row.turnId) messageIds.add(messageId);
  }
  return [...messageIds];
}

/**
 * core 侧强校验：
 * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
 * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
 */
export function isLatestAssistantSegmentRowImpl(state: ProjectionState, rowId: number): boolean {
  const row = findRow(state, rowId);
  if (row?.kind !== "assistantText") return false;
  for (let index = state.snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const candidate = state.snapshot.rows.window[index]!;
    if (candidate.kind === "assistantText" && candidate.turnId === row.turnId) {
      return candidate.rowId === rowId;
    }
  }
  return false;
}

/**
 * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
 * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
 */
export function resolveStableForkCandidateImpl(
  state: ProjectionState,
  rowId: number,
): StableForkCandidateResolution {
  if (state.snapshot.control.activeWorks.some((work) => work.kind === "compact")) {
    return { ok: false, reasonCode: "guard.compactOperationLock" };
  }
  const row = findRow(state, rowId);
  if (row?.kind !== "assistantText") {
    return { ok: false, reasonCode: "guard.forkAssistantOnly" };
  }
  const headerRowId = state.turnHeaderRowIdByTurnId.get(row.turnId);
  const header = headerRowId === undefined ? undefined : findRow(state, headerRowId);
  if (
    row.state !== "complete" ||
    row.actions?.canFork !== true ||
    header?.kind !== "turnHeader" ||
    header.state !== "completedSuccess" ||
    !isLatestAssistantSegmentRowImpl(state, rowId)
  ) {
    return { ok: false, reasonCode: "guard.forkTargetNotStable" };
  }
  const boundaryMessageId = state.messageIdByRowId.get(rowId);
  if (!boundaryMessageId) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const startMessageId =
    state.snapshot.rows.window
      .filter((candidate) => candidate.turnId === row.turnId && candidate.kind === "userInput")
      .map((candidate) => state.messageIdByRowId.get(candidate.rowId))
      .find((messageId): messageId is string => Boolean(messageId)) ?? null;
  return {
    ok: true,
    candidate: {
      productTurnId: row.turnId,
      transcriptTurnId: state.runtimeTurnIdByProductTurnId.get(row.turnId) ?? row.turnId,
      startMessageId,
      boundaryMessageId,
    },
  };
}

/** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */
export function isLatestRetryAssistantRowImpl(state: ProjectionState, rowId: number): boolean {
  const row = findRow(state, rowId);
  return Boolean(
    row?.kind === "assistantText" &&
    row.actions?.canRetry === true &&
    state.messageIdByRowId.has(rowId),
  );
}

/** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */
export function isLatestEditableUserRowImpl(state: ProjectionState, rowId: number): boolean {
  const row = findRow(state, rowId);
  return Boolean(
    row?.kind === "userInput" &&
    row.origin === "realUser" &&
    row.actions?.canEdit === true &&
    state.messageIdByRowId.has(rowId),
  );
}

/** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */
export function getTurnIdForRowImpl(state: ProjectionState, rowId: number): string | null {
  return findRow(state, rowId)?.turnId ?? null;
}
