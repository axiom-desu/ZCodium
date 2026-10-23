import type {
  MessageWithParts,
  SessionEvent,
  SessionGoal,
  TurnFileChangeSummary,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  synthesizeEventsFromMessages,
  type HydratedGoalVerificationEntry,
} from "./transcript-hydration.js";
import {
  LIVE_ONLY_EVENT_TYPES,
  MEMORY_ONLY_EVENT_TYPES,
  TRANSCRIPT_DERIVED_EVENT_TYPES,
  HOOK_LIFECYCLE_EVENT_TYPES,
  hookInvocationTurnIds,
  memoryAuthorityTurnIds,
  queueStateEventIndexes,
  recordDiagnostic,
  resumedSubagentLifecycleEventIndexes,
  setupModelEventIndexes,
  stringField,
  type ColdEventMergeDiagnostic,
} from "./cold-event-merge-indexes.js";
import {
  boundaryAnchorMessageId,
  durableBoundaryKeyForEvent,
  durableBoundaryKeys,
  durableHookTurnByInvocationId,
  durableTurnByMessageId,
  durableTurnByRuntimeAnchor,
  insertAtDurableTurnBoundaries,
  resequence,
} from "./cold-event-merge-anchors.js";

export { loadPersistedConversationMaterialization } from "./cold-event-merge-materialization.js";

export interface ColdEventMergeResult {
  diagnostics: ColdEventMergeDiagnostic[];
  events: SessionEvent[];
  usedDurableTranscript: boolean;
}

interface MergeInput {
  contextWindow?: number;
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  memoryEvents: readonly SessionEvent[];
  messages: readonly MessageWithParts[];
  sessionId: string;
  target?: SessionGoal | null;
}

/**
 * 冷恢复三源合并：message/part 是已完成正文权威；session_entry 只补 legacy goal；
 * 内存事件只补未完成 turn 与没有 transcript 形态的当前状态。
 */
export function mergeColdConversationEvents(input: MergeInput): ColdEventMergeResult {
  const diagnostics = new Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>();
  const hasPersistedTargetAuthority = Object.prototype.hasOwnProperty.call(input, "target");
  const authorityTurns = memoryAuthorityTurnIds(input.memoryEvents, input.messages);
  const authorityTurnIds = authorityTurns.turnIds;
  for (const event of authorityTurns.ambiguousLegacyStarts) {
    // 旧 TurnStarted 既没有 messageId，transcript 也没有同 turn anchor 时，
    // 禁止用 input 文本/时间猜测实体同一性。相同文本可以是两次真实提交；
    // 宁可保留该内存 turn 并显式诊断，也不能把未持久 in-flight 误当重复删掉。
    recordDiagnostic(diagnostics, "cold_merge.ambiguous_legacy_turn_preserved", event);
  }
  const durableMessages = input.messages.filter(
    (message) =>
      !message.info.anchor?.turnId || !authorityTurnIds.has(String(message.info.anchor.turnId)),
  );
  const durableGoalEntries = (input.goalVerificationEntries ?? []).filter(
    (entry) => !entry.payload.anchorTurnId || !authorityTurnIds.has(entry.payload.anchorTurnId),
  );
  const transcriptEvents = synthesizeEventsFromMessages(durableMessages, {
    sessionId: input.sessionId,
    contextWindow: input.contextWindow,
    fileChangeSummariesByMessageId: input.fileChangeSummariesByMessageId,
    goalVerificationEntries: durableGoalEntries,
  });
  const durableEvents = input.target
    ? [
        ...transcriptEvents.slice(0, 1),
        {
          id: "hydrate-goal-state" as SessionEvent["id"],
          sessionId: input.sessionId as SessionEvent["sessionId"],
          type: SessionEventType.TargetChanged,
          timestamp: new Date(input.target.time.updated),
          traceId: "trace-hydration" as SessionEvent["traceId"],
          sequenceNumber: 0,
          payload: { action: "set", source: "runtime", target: input.target },
        },
        ...transcriptEvents.slice(1),
      ]
    : transcriptEvents;
  const durableTurnIds = new Set(
    durableEvents.flatMap((event) => (event.turnId ? [String(event.turnId)] : [])),
  );
  const queueIndexes = queueStateEventIndexes(input.memoryEvents);
  const resumedSubagentIndexes = resumedSubagentLifecycleEventIndexes(input.memoryEvents);
  const modelSetupIndexes = setupModelEventIndexes(
    input.memoryEvents,
    authorityTurnIds,
    input.messages,
  );
  const supplements: SessionEvent[] = [];
  const prefixEventsByTurnId = new Map<string, SessionEvent[]>();
  const boundaryEventsByTurnId = new Map<string, SessionEvent[]>();
  const boundaryKeys = durableBoundaryKeys(durableMessages, durableGoalEntries);
  const turnByMessageId = durableTurnByMessageId(durableMessages, durableEvents);
  const turnByRuntimeAnchor = durableTurnByRuntimeAnchor(durableMessages, turnByMessageId);
  const hookTurnIdByInvocationId = hookInvocationTurnIds(input.memoryEvents);
  const durableHookTurnByInvocation = durableHookTurnByInvocationId(
    input.memoryEvents,
    turnByMessageId,
  );

  input.memoryEvents.forEach((event, index) => {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      // invocation 扫描会把 startup/resume SessionStart 的临时 runtime turn 修正为
      // 后续真实 TurnStarted；因此它必须优先于单条事件上尚未建立 product mapping
      // 的 turnId。普通 prompt/tool invocation 得到的仍是同一个 runtime turn。
      const resolvedTurnId = invocationId
        ? (hookTurnIdByInvocationId.get(invocationId) ??
          (event.turnId ? String(event.turnId) : undefined))
        : event.turnId
          ? String(event.turnId)
          : undefined;
      const durableTurnId =
        (invocationId ? durableHookTurnByInvocation.get(invocationId) : undefined) ??
        (resolvedTurnId
          ? durableTurnIds.has(resolvedTurnId)
            ? resolvedTurnId
            : turnByRuntimeAnchor.get(resolvedTurnId)
          : undefined);
      if (durableTurnId) {
        const eventName = stringField(event.payload, "hookEventName");
        const target = eventName === "SessionStart" ? prefixEventsByTurnId : boundaryEventsByTurnId;
        const events = target.get(durableTurnId) ?? [];
        // memory Hook 保留 runtime turnId，而 transcript synthesis 使用
        // hydrate-turn-*；直接比较两者会让 completed Hook 变成 orphan row，
        // SessionStart 也会残留 pending。先改写到 hydration turn 后，既有
        // ProductProjection TurnStarted 映射会继续收敛到稳定 message product turn。
        events.push({ ...event, turnId: durableTurnId as TurnId });
        target.set(durableTurnId, events);
      } else {
        // 只打开历史而尚无下一真实 turn 的 resume SessionStart 继续留作 projection
        // pending，不为它制造 synthetic turn；后续 live TurnStarted 会完成归位。
        supplements.push(event);
      }
      return;
    }
    const boundary = durableBoundaryKeyForEvent(event);
    if (boundary) {
      if (boundary.key && boundaryKeys[boundary.kind].has(boundary.key)) {
        recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
        return;
      }
      // durable boundary 写 part/session_entry 失败时，内存事件是唯一剩余事实。
      // boundary 的持久实体 anchor 优先于事件到达时所在的 active runtime turn；
      // 否则迟到 boundary 会被误留在 unfinished turn 末尾。
      const anchorMessageId = boundaryAnchorMessageId(event);
      const durableTurnId = anchorMessageId ? turnByMessageId.get(anchorMessageId) : undefined;
      if (durableTurnId) {
        const events = boundaryEventsByTurnId.get(durableTurnId) ?? [];
        // durableEvents + supplements 不能直接拼接：即使 boundary
        // 带持久 message anchor，也会被挪到整个 transcript 末尾。这里同时改写为
        // hydration product turn 并插入该轮 tail，身份和物理顺序一次对齐。
        events.push({ ...event, turnId: durableTurnId as TurnId });
        boundaryEventsByTurnId.set(durableTurnId, events);
      } else {
        // legacy 无显式/可解析 anchor：按冻结 fallback 放最后一个已知宿主之后；
        // memory_boundary_preserved diagnostic 让这次降级保持可观测。
        supplements.push(event);
      }
      recordDiagnostic(diagnostics, "cold_merge.memory_boundary_preserved", event);
      return;
    }
    const turnId = event.turnId ? String(event.turnId) : null;
    if (turnId && authorityTurnIds.has(turnId)) {
      supplements.push(event);
      return;
    }
    if (queueIndexes.has(index) || modelSetupIndexes.has(index)) {
      supplements.push(event);
      return;
    }
    if (
      event.type === SessionEventType.TurnSteerQueued ||
      event.type === SessionEventType.TurnSteerDeliveryChanged ||
      event.type === SessionEventType.TurnSteerDispatchChanged ||
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded ||
      event.type === SessionEventType.SessionInputPromoted ||
      event.type === SessionEventType.TurnSteerReordered ||
      event.type === SessionEventType.QueueAutoDrainChanged ||
      event.type === SessionEventType.FollowupModeChanged
    ) {
      recordDiagnostic(diagnostics, "cold_merge.settled_queue_event_suppressed", event);
      return;
    }
    if (event.type === SessionEventType.TargetChanged && hasPersistedTargetAuthority) {
      // session_target 已是持久权威，旧 merge 却把内存 TargetChanged 当
      // ephemeral 尾事件追加，冷恢复终态会被旧 goal 覆盖；显式 null 也必须压掉旧事件。
      recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
      return;
    }
    if (LIVE_ONLY_EVENT_TYPES.has(event.type)) {
      // 插件 UI 资源通知只对当时活着的沙箱实例有意义，冷恢复一律丢弃。
      recordDiagnostic(diagnostics, "cold_merge.non_product_event_suppressed", event);
      return;
    }
    if (MEMORY_ONLY_EVENT_TYPES.has(event.type)) {
      supplements.push(event);
      return;
    }
    if (resumedSubagentIndexes.has(index)) {
      // SendMessage tool transcript 不会合成它恢复的 child lifecycle；若按普通
      // transcript-derived Subagent* 去重，replayable 重连会丢失正在运行的 row 和 Stop 控制。
      supplements.push(event);
      return;
    }
    if (TRANSCRIPT_DERIVED_EVENT_TYPES.has(event.type)) {
      recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
      return;
    }
    // ProductProjection 当前可能忽略这类事件，但读取层不能把未知老事实静默删掉；
    // 保留原事件并聚合诊断，后续 normalizer 扩词表时仍有输入可追溯。
    supplements.push(event);
    recordDiagnostic(diagnostics, "cold_merge.unclassified_event_preserved", event);
  });

  return {
    diagnostics: [...diagnostics.values()],
    events: resequence(
      insertAtDurableTurnBoundaries({
        durableEvents,
        trailingEvents: supplements,
        turnPrefixEvents: prefixEventsByTurnId,
        turnTailEvents: boundaryEventsByTurnId,
      }),
    ),
    usedDurableTranscript:
      durableMessages.length > 0 || durableGoalEntries.length > 0 || hasPersistedTargetAuthority,
  };
}
