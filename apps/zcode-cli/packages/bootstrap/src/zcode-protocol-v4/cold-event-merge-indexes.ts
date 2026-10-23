import { SessionEventType, type MessageWithParts, type SessionEvent } from "@zcode/contracts";

export interface ColdEventMergeDiagnostic {
  code:
    | "cold_merge.durable_event_suppressed"
    | "cold_merge.ambiguous_legacy_turn_preserved"
    | "cold_merge.settled_queue_event_suppressed"
    | "cold_merge.memory_boundary_preserved"
    | "cold_merge.non_product_event_suppressed"
    | "cold_merge.unclassified_event_preserved";
  count: number;
  eventTypes: Record<string, number>;
}

export const LIVE_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.PluginUiResourceUpdated,
  SessionEventType.PluginUiResourceListChanged,
  SessionEventType.PluginUiAppToolCallRequested,
  SessionEventType.PluginUiInstanceClosed,
]);

export const MEMORY_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionResumed,
  SessionEventType.SessionTitleUpdated,
  SessionEventType.SessionModeChanged,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.UserInputAutoResolutionUpdated,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  // workflow run 进度：权威事实在 dwf_event journal 与内存事件里，durable transcript（message/part）
  // 从不合成它，所以它与 BackgroundTask* 同类——memory-only 权威。不分类的后果不是丢事件
  // （兜底分支同样保留），而是每次冷恢复刷一条 unclassified 诊断，把"真的漏了词汇表"这个
  // 信号淹掉。
  SessionEventType.DynamicWorkflowRunProgress,
  SessionEventType.TargetChanged,
  SessionEventType.RewindTriggered,
]);

export const TRANSCRIPT_DERIVED_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionCreated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelSelected,
  SessionEventType.ModelStreaming,
  SessionEventType.ModelComplete,
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.CompactStarted,
  SessionEventType.CompactCompleted,
  SessionEventType.CompactFailed,
  SessionEventType.TargetCompletionVerification,
  SessionEventType.SessionForked,
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentMessage,
  SessionEventType.SubagentStopped,
]);

export const HOOK_LIFECYCLE_EVENT_TYPES = new Set<string>([
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);

export function hookInvocationTurnIds(events: readonly SessionEvent[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const pending = new Set<string>();
  for (const event of events) {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      if (!invocationId) continue;
      const eventName = stringField(event.payload, "hookEventName");
      if (eventName === "SessionStart") {
        // startup SessionStart 可能已经携带尚未映射的 runtime turnId；只有后续真实
        // TurnStarted 才能给出 durable product turn。async terminal 若已解析则沿用。
        if (!resolved.has(invocationId)) pending.add(invocationId);
        continue;
      }
      if (event.turnId) {
        resolved.set(invocationId, String(event.turnId));
        pending.delete(invocationId);
      } else if (!resolved.has(invocationId)) {
        pending.add(invocationId);
      }
      continue;
    }
    if (event.type !== SessionEventType.TurnStarted || !event.turnId || pending.size === 0) {
      continue;
    }
    // model-only 维护 turn（manual /compact、goal continuation）没有资格承载
    // SessionStart 摘要；resume SessionStart 必须等下一条 user-visible 真实 turn 归位。
    if (stringField(event.payload, "inputVisibility") === "model-only") continue;
    // resume SessionStart 在 Runtime 中先于下一条真实 TurnStarted；cold merge 必须沿
    // 同一事件顺序建立归属，不能把它追加到历史末尾或由 Renderer 猜最近一轮。
    for (const invocationId of pending) resolved.set(invocationId, String(event.turnId));
    pending.clear();
  }
  return resolved;
}

export function recordDiagnostic(
  diagnostics: Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>,
  code: ColdEventMergeDiagnostic["code"],
  event: SessionEvent,
): void {
  const existing = diagnostics.get(code);
  if (existing) {
    existing.count += 1;
    existing.eventTypes[event.type] = (existing.eventTypes[event.type] ?? 0) + 1;
    return;
  }
  diagnostics.set(code, {
    code,
    count: 1,
    eventTypes: { [event.type]: 1 },
  });
}

export function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function stringArrayField(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

export function memoryAuthorityTurnIds(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
): { ambiguousLegacyStarts: SessionEvent[]; turnIds: Set<string> } {
  const started = new Map<string, SessionEvent>();
  const terminal = new Set<string>();
  for (const event of events) {
    const turnId = event.turnId ? String(event.turnId) : null;
    if (!turnId) continue;
    if (event.type === SessionEventType.TurnStarted) started.set(turnId, event);
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      terminal.add(turnId);
    }
  }

  const persistedMessageIds = new Set(messages.map((message) => String(message.info.id)));
  const persistedTurnIds = new Set(
    messages.flatMap((message) =>
      message.info.anchor?.turnId ? [String(message.info.anchor.turnId)] : [],
    ),
  );
  const authority = new Set<string>();
  const ambiguousLegacyStarts: SessionEvent[] = [];
  for (const [turnId, start] of started) {
    if (!terminal.has(turnId)) {
      authority.add(turnId);
      continue;
    }
    const messageId = stringField(start.payload, "messageId");
    const hasDurableStarter =
      (messageId !== null && persistedMessageIds.has(messageId)) || persistedTurnIds.has(turnId);
    if (!hasDurableStarter) {
      authority.add(turnId);
      if (messageId === null) ambiguousLegacyStarts.push(start);
    }
  }
  return { ambiguousLegacyStarts, turnIds: authority };
}

export function resumedSubagentLifecycleEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const keep = new Set<number>();
  const resumedAgentIds = new Set<string>();
  events.forEach((event, index) => {
    const agentId = stringField(event.payload, "agentId");
    if (!agentId) return;
    if (event.type === SessionEventType.SubagentSpawned) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.resumed === true) {
        resumedAgentIds.add(agentId);
        keep.add(index);
      }
      return;
    }
    if (event.type === SessionEventType.SubagentStopped && resumedAgentIds.has(agentId)) {
      keep.add(index);
    }
  });
  return keep;
}

export function queueStateEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const queuedLifecycleById = new Map<string, number[]>();
  const latestDispatchById = new Map<string, number>();
  const latestDeliveryChangeById = new Map<string, number>();
  const pendingIds = new Set<string>();
  let latestReorder: number | null = null;
  let latestAutoDrain: number | null = null;
  let latestFollowupMode: number | null = null;

  events.forEach((event, index) => {
    if (event.type === SessionEventType.TurnSteerQueued) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.add(id);
        const lifecycle = queuedLifecycleById.get(id) ?? [];
        lifecycle.push(index);
        queuedLifecycleById.set(id, lifecycle);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerDispatchChanged) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestDispatchById.set(id, index);
      return;
    }
    if (event.type === SessionEventType.TurnSteerDeliveryChanged) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestDeliveryChangeById.set(id, index);
      return;
    }
    if (event.type === SessionEventType.TurnSteerDrained) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerDiscarded) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerReordered) latestReorder = index;
    if (event.type === SessionEventType.QueueAutoDrainChanged) latestAutoDrain = index;
    if (event.type === SessionEventType.FollowupModeChanged) latestFollowupMode = index;
  });

  const keep = new Set<number>();
  for (const id of pendingIds) {
    const queuedLifecycle = queuedLifecycleById.get(id) ?? [];
    const dispatch = latestDispatchById.get(id);
    const deliveryChange = latestDeliveryChangeById.get(id);
    // editQueueItem 在旧事件里可能只重发新 text，完整 intent/附件/来源
    // 仍只在首次 queued 事件。从空投影 cold replay 时必须保留该 id
    // 自最近一次 admission 起的全部 queued 生命周期，让 reducer 原地合并字段。
    for (const queued of queuedLifecycle) keep.add(queued);
    const latestQueued = queuedLifecycle.at(-1) ?? -1;
    if (dispatch !== undefined && dispatch > latestQueued) keep.add(dispatch);
    if (deliveryChange !== undefined && deliveryChange > latestQueued) keep.add(deliveryChange);
  }
  if (latestReorder !== null && pendingIds.size > 0) keep.add(latestReorder);
  if (latestAutoDrain !== null) keep.add(latestAutoDrain);
  if (latestFollowupMode !== null) keep.add(latestFollowupMode);
  return keep;
}

export function setupModelEventIndexes(
  events: readonly SessionEvent[],
  authorityTurnIds: ReadonlySet<string>,
  messages: readonly MessageWithParts[],
): Set<number> {
  const keep = new Set<number>();
  let latestModelSelected: number | null = null;
  events.forEach((event, index) => {
    if (event.type === SessionEventType.ModelSelected) latestModelSelected = index;
    if (
      event.type === SessionEventType.TurnStarted &&
      event.turnId &&
      authorityTurnIds.has(String(event.turnId)) &&
      latestModelSelected !== null
    ) {
      keep.add(latestModelSelected);
    }
  });
  if (messages.length === 0 && latestModelSelected !== null) keep.add(latestModelSelected);
  return keep;
}
