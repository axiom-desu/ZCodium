import type { SessionEvent, SessionForkedPayload } from "@zcode/contracts";
import type { ProjectionState } from "./product-projection-state.js";
import type {
  ConversationDelta,
  HookExecutionProjection,
  TimelineMarkerRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  findRow,
  ms,
  queuePatch,
  rewindAnchorForRows,
  rowBase,
  rowIdForMessageId,
  turnIdOf,
} from "./product-projection-primitives.js";

/** A persisted started-only Hook cannot still be running after a real runtime resume. */
export function onSessionResumed(
  state: Pick<ProjectionState, "pendingSessionHookInvocations" | "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const endedAt = ms(event);
  const deltas: ConversationDelta[] = [];
  // Runtime epoch 切换前尚未归位的 session Hook 不得附着到新 epoch 的下一轮；
  // 新 Runtime 会重新产生自己的 resume SessionStart lifecycle。
  state.pendingSessionHookInvocations.clear();
  for (const row of state.snapshot.rows.window) {
    if (row.kind !== "hookInvocation" || row.state !== "running") continue;
    const executions = row.executions.map(
      (execution): HookExecutionProjection =>
        execution.state === "running"
          ? {
              ...execution,
              state: "failed",
              outcome: "cancelled",
              endedAt,
              durationMs: Math.max(0, endedAt - execution.startedAt),
            }
          : execution,
    );
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        state: "failed",
        executions,
        endedAt,
        durationMs: Math.max(0, endedAt - row.startedAt),
      },
    });
  }
  const pendingInteractions = state.snapshot.pendingInteractions.filter(
    (interaction) => interaction.payload.kind !== "workspaceHookReview",
  );
  if (pendingInteractions.length !== state.snapshot.pendingInteractions.length) {
    // reviewFlowId/generation 只在单个 Runtime controller 内单调。
    // Runtime 重启后旧 Requested 会先被 replay，而新 flow 又从 generation=1 开始；
    // SessionResumed 是明确的新 Runtime epoch 边界，必须先淘汰旧 Runtime 无法再解析的审核。
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  // 软门禁:resume 后 activate 会重新上报 admission 状态。
  // epoch 清理时置 null,避免旧 Runtime 的提示条残留到新 Runtime 接管前。
  if (state.snapshot.workspaceHookAdmission !== null) {
    deltas.push({ op: "state.updated", patch: { workspaceHookAdmission: null } });
  }
  return deltas;
}

/**
 * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
 * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
 * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
 * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
 * 由 transcript 合成 hydration 兜底重建。
 * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
 */
export function onRewindTriggered(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    targetMessageId?: string;
    scope?: string;
    branchCutAfterMessageId?: string;
    branchGeneration?: number;
    createdMessageId?: string;
    reason?: string;
  };
  if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = rowIdForMessageId(state, targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = findRow(state, targetRowId);
    if (!targetRow) return [];
    const headerRowId = state.turnHeaderRowIdByTurnId.get(targetRow.turnId);
    const headerRow = headerRowId !== undefined ? findRow(state, headerRowId) : undefined;
    if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...headerRow,
          fileChanges: {
            ...headerRow.fileChanges,
            state: "reverted",
          },
        },
      },
    ];
  }
  // 新语义只消费带 branchGeneration/cut 的已提交 conversation rewind；createdMessageId
  // 仅兼容旧 transcript。失败/冲突不发事件，因此不会制造 UI 假截断。
  const applied =
    (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
    payload.createdMessageId !== undefined;
  if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
  const targetMessageId = payload.targetMessageId;
  if (!targetMessageId) return [];
  const targetRowId = rowIdForMessageId(state, targetMessageId);
  if (targetRowId === null) return [];
  const targetRow = findRow(state, targetRowId);
  if (!targetRow) return [];
  // 从该行所属 turn 的首行起移除（整段 turn 被 rewind/edit/retry 替换）。
  const turnHeaderRowId = state.turnHeaderRowIdByTurnId.get(targetRow.turnId) ?? targetRowId;
  const fromRowId = Math.min(turnHeaderRowId, targetRowId);
  // 清理被移除行的 messageId/tool 索引，避免悬挂映射。
  for (const [rowId] of state.messageIdByRowId) {
    if (rowId >= fromRowId) state.messageIdByRowId.delete(rowId);
  }
  for (const [messageId, rowId] of state.outputContinuationRowIdByMessageId) {
    if (rowId >= fromRowId) state.outputContinuationRowIdByMessageId.delete(messageId);
  }
  for (const [rowId, entityId] of state.entityIdByRowId) {
    if (rowId >= fromRowId) {
      state.entityIdByRowId.delete(rowId);
      state.editTargetByEntityId.delete(entityId);
    }
  }
  for (const [hookInvocationId, rowId] of state.hookRowIdByInvocationId) {
    if (rowId >= fromRowId) {
      state.rewoundHookInvocationIds.add(hookInvocationId);
      state.hookRowIdByInvocationId.delete(hookInvocationId);
    }
  }
  return [{ op: "row.removed", fromRowId }];
}

/**
 * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
 * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
 * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
 */
export function getTurnRewindAnchorImpl(
  state: Pick<ProjectionState, "messageIdByRowId" | "snapshot">,
  rowId: number,
): string | null {
  return rewindAnchorForRows(state, state.snapshot.rows.window, rowId);
}

// ── 生命周期 ──

export function onSessionCreated(
  state: Pick<ProjectionState, "contextWindowState">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { contextWindow?: number };
  state.contextWindowState.maxTokens = payload.contextWindow ?? null;
  // draft 语义：会话实体已存在、无 row；phase 保持 draft，无可见 delta。
  return [];
}

// renameSession / 自动标题：SessionTitleUpdated(title, source) → 更新 meta。
// custom（用户重命名）优先级最高，已 custom 后不再被 generated 覆盖（与 core titleSource 一致）。
export function onSessionTitleUpdated(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    title?: string;
    source?: string;
  };
  const title = payload.title ?? "";
  // core 的 titleSource 有 4 值（default/first_input/generated/custom）；投影 meta 归一为
  // default/generated/custom（first_input 归入 generated：都属"非用户显式"）。
  const source: "default" | "generated" | "custom" =
    payload.source === "custom" ? "custom" : payload.source === "default" ? "default" : "generated";
  const prev = state.snapshot.meta;
  if (prev.titleSource === "custom" && source === "generated") return [];
  if (prev.title === title && prev.titleSource === source) return [];
  return [
    {
      op: "state.updated",
      patch: { meta: { title, titleSource: source } },
    },
  ];
}

/**
 * switchCollaborationMode：SessionModeChanged → config.mode。
 * 事件来源覆盖命令面（source=command）与 plan 工具路径（enterPlanMode/exitPlanMode，
 * source=tool）——两条路径共用这条投影，UI 的模式选择器因此也能跟随工具驱动的模式切换。
 */
export function onSessionModeChanged(
  state: Pick<ProjectionState, "configModeTouchedByEvent" | "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    mode?: string;
    planEnabled?: boolean;
    source?: string;
    toolCallId?: string;
    permissionGrant?: { interactionId: string; queueItemIds: string[] };
  };
  const mode = typeof payload.mode === "string" ? payload.mode : "";
  // 日志事件触碰过 mode 后，种子不再覆盖（同值 return 也算触碰——日志有权威值）。
  if (mode) state.configModeTouchedByEvent = true;
  if (!mode) return [];
  const planEnabled = payload.planEnabled ?? mode === "plan";
  const planTransition =
    payload.source === "tool" && payload.toolCallId
      ? { toolCallId: payload.toolCallId, planEnabled }
      : state.snapshot.config.planTransition;
  if (
    state.snapshot.config.mode === mode &&
    state.snapshot.config.planEnabled === planEnabled &&
    planTransition === state.snapshot.config.planTransition &&
    !payload.permissionGrant
  )
    return [];
  return [
    {
      op: "state.updated",
      patch: {
        ...(payload.permissionGrant
          ? queuePatch(state, {
              ...state.snapshot.queue,
              items: state.snapshot.queue.items.map((item) =>
                payload.permissionGrant!.queueItemIds.includes(item.queueItemId)
                  ? { ...item, mode: "yolo" as const }
                  : item,
              ),
            })
          : {}),
        config: {
          ...state.snapshot.config,
          mode,
          planEnabled,
          planTransition,
          ...(payload.permissionGrant
            ? { permissionGrant: { interactionId: payload.permissionGrant.interactionId } }
            : {}),
        },
      },
    },
  ];
}

// ── fork marker（forkAssistant 命令效果）──

export function onSessionForked(state: ProjectionState, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as SessionForkedPayload;
  const isParent = String(payload.originalSessionId) === state.snapshot.sessionId;
  if (isParent) {
    // 父时间线不显示 forkCreated——fork 关系只在 sessions
    // 树/列表体现。旧实现以 nextRowId-1 近似锚点产 row，且 UI 渲染为 null
    // （隐形行污染 turn 分组）；child 首部 forkNotice 保留不变。
    return [];
  }
  // child 首部 forkNotice（forkTimelineIsBoundary）：事件 payload 不携带
  // parent 侧 rowId，先以 0 占位；transcript 锚点 → rowId 映射随传输外壳补齐。
  const row: TimelineMarkerRow = {
    ...rowBase(
      state,
      event,
      turnIdOf(state, event),
      `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
    ),
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: String(payload.originalSessionId),
      parentRowId: 0,
    },
  };
  return [{ op: "row.appended", row }];
}
