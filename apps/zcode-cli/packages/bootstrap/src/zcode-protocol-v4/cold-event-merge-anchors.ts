import { SessionEventType, type MessageWithParts, type SessionEvent } from "@zcode/contracts";
import {
  HOOK_LIFECYCLE_EVENT_TYPES,
  hookInvocationTurnIds,
  stringArrayField,
  stringField,
} from "./cold-event-merge-indexes.js";
import type { HydratedGoalVerificationEntry } from "./transcript-hydration.js";

interface DurableBoundaryKeys {
  compact: Set<string>;
  fork: Set<string>;
  goal: Set<string>;
}

function goalKey(payload: unknown): string | null {
  const targetId = stringField(payload, "targetId");
  const verificationId = stringField(payload, "verificationId");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const goalIteration = (payload as Record<string, unknown>).goalIteration;
  if (targetId && typeof goalIteration === "number") return `${targetId}_${goalIteration}`;
  return verificationId;
}

export function durableBoundaryKeys(
  messages: readonly MessageWithParts[],
  goalEntries: readonly HydratedGoalVerificationEntry[],
): DurableBoundaryKeys {
  const compact = new Set<string>();
  const fork = new Set<string>();
  const goal = new Set<string>();
  for (const entry of goalEntries) {
    const key = goalKey(entry.payload);
    if (key) goal.add(key);
  }
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "timeline") {
        if (part.timelineType === "goal_verification") {
          const key = goalKey(part);
          if (key) goal.add(key);
        } else if (part.timelineType === "context_compaction") {
          compact.add(String(part.operationId));
        } else if (part.timelineType === "session_fork") {
          fork.add(`${String(part.parentSessionId)}\u0000${String(part.targetMessageId)}`);
        }
        continue;
      }
      if (part.type === "compaction") {
        compact.add(String(part.operationId ?? part.boundaryId ?? `legacy-compact-${part.id}`));
      }
    }
  }
  return { compact, fork, goal };
}

export function durableBoundaryKeyForEvent(
  event: SessionEvent,
): { key: string | null; kind: keyof DurableBoundaryKeys } | null {
  if (event.type === SessionEventType.TargetCompletionVerification) {
    return { kind: "goal", key: goalKey(event.payload) };
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    return { kind: "compact", key: stringField(event.payload, "operationId") };
  }
  if (event.type === SessionEventType.SessionForked) {
    const parent = stringField(event.payload, "originalSessionId");
    const target = stringField(event.payload, "targetMessageId");
    return { kind: "fork", key: parent && target ? `${parent}\u0000${target}` : null };
  }
  return null;
}

function eventMessageIds(event: SessionEvent): string[] {
  const ids = [
    stringField(event.payload, "messageId"),
    stringField(event.payload, "assistantMessageId"),
  ].filter((id): id is string => id !== null);
  ids.push(...stringArrayField(event.payload, "injectedMessageIds"));
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const drainedInputs = (event.payload as Record<string, unknown>).drainedInputs;
    if (Array.isArray(drainedInputs)) {
      for (const input of drainedInputs) {
        const messageId = stringField(input, "messageId");
        if (messageId) ids.push(messageId);
      }
    }
  }
  return ids;
}

/**
 * 只靠持久实体 ID 建立 transcript message → hydration turn 映射。
 * assistant 没有 text part 时可能不直接产 assistantMessageId，因此再用持久的
 * parentID / anchor.turnId 传播；禁止用文本或时间邻近猜测轮归属。
 */
export function durableTurnByMessageId(
  messages: readonly MessageWithParts[],
  events: readonly SessionEvent[],
): Map<string, string> {
  const turnByMessageId = new Map<string, string>();
  for (const event of events) {
    if (!event.turnId) continue;
    for (const messageId of eventMessageIds(event)) {
      turnByMessageId.set(messageId, String(event.turnId));
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const turnByRuntimeAnchor = new Map<string, string>();
    for (const message of messages) {
      const turnId = turnByMessageId.get(String(message.info.id));
      const runtimeAnchor = message.info.anchor?.turnId;
      if (turnId && runtimeAnchor) turnByRuntimeAnchor.set(String(runtimeAnchor), turnId);
    }
    for (const message of messages) {
      const messageId = String(message.info.id);
      if (turnByMessageId.has(messageId)) continue;
      const parentTurn =
        message.info.role === "assistant" && message.info.parentID
          ? turnByMessageId.get(String(message.info.parentID))
          : undefined;
      const anchorTurn = message.info.anchor?.turnId
        ? turnByRuntimeAnchor.get(String(message.info.anchor.turnId))
        : undefined;
      const turnId = parentTurn ?? anchorTurn;
      if (!turnId) continue;
      turnByMessageId.set(messageId, turnId);
      changed = true;
    }
  }
  return turnByMessageId;
}

/**
 * Hook lifecycle 只携带 runtime turnId，没有持久 messageId；cold transcript 则会
 * 重新生成 hydrate-turn-*。这里只使用持久 message anchor 建立无歧义身份映射，
 * 禁止按文本或时间邻近猜测。若同一 runtime anchor 指向多个 hydration turn，宁可
 * 保留原事件等待显式恢复边界，也不能把 Hook 错挂到另一轮。
 */
export function durableTurnByRuntimeAnchor(
  messages: readonly MessageWithParts[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const turnByRuntimeAnchor = new Map<string, string>();
  const ambiguousRuntimeAnchors = new Set<string>();
  for (const message of messages) {
    const runtimeAnchor = message.info.anchor?.turnId;
    const durableTurnId = turnByMessageId.get(String(message.info.id));
    if (!runtimeAnchor || !durableTurnId) continue;
    const runtimeTurnId = String(runtimeAnchor);
    if (ambiguousRuntimeAnchors.has(runtimeTurnId)) continue;
    const existing = turnByRuntimeAnchor.get(runtimeTurnId);
    if (existing && existing !== durableTurnId) {
      turnByRuntimeAnchor.delete(runtimeTurnId);
      ambiguousRuntimeAnchors.add(runtimeTurnId);
      continue;
    }
    turnByRuntimeAnchor.set(runtimeTurnId, durableTurnId);
  }
  return turnByRuntimeAnchor;
}

/**
 * queue drain 可在同一 runtime turn 内切出多个 product turn；Hook 仍只携带
 * runtime turnId，因此必须按事件顺序跟随持久 message boundary。首次 lifecycle
 * 一旦解析成功就冻结 invocation 归属，避免后台 terminal 跨 boundary 后改挂。
 */
export function durableHookTurnByInvocationId(
  events: readonly SessionEvent[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const currentTurnByRuntimeId = new Map<string, string>();
  const runtimeTurnByPendingInputId = new Map<string, string>();
  const runtimeTurnByInvocationId = hookInvocationTurnIds(events);
  const durableTurnByInvocationId = new Map<string, string>();

  const advance = (runtimeTurnId: string | null, messageId: string | null): void => {
    if (!runtimeTurnId || !messageId) return;
    const durableTurnId = turnByMessageId.get(messageId);
    if (durableTurnId) currentTurnByRuntimeId.set(runtimeTurnId, durableTurnId);
  };

  for (const event of events) {
    if (event.type === SessionEventType.TurnStarted) {
      advance(event.turnId ? String(event.turnId) : null, stringField(event.payload, "messageId"));
    } else if (event.type === SessionEventType.TurnSteerDrained) {
      const runtimeTurnId =
        stringField(event.payload, "targetTurnId") ?? (event.turnId ? String(event.turnId) : null);
      const drainedInputs =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>).drainedInputs
          : undefined;
      if (runtimeTurnId && Array.isArray(drainedInputs)) {
        for (const input of drainedInputs) {
          const pendingInputId = stringField(input, "pendingInputId");
          if (pendingInputId) runtimeTurnByPendingInputId.set(pendingInputId, runtimeTurnId);
          if (stringField(input, "delivery") !== "guide") {
            advance(runtimeTurnId, stringField(input, "messageId"));
          }
        }
      }
    } else if (event.type === SessionEventType.SessionInputPromoted) {
      const pendingInputId = stringField(event.payload, "pendingInputId");
      const runtimeTurnId = event.turnId
        ? String(event.turnId)
        : pendingInputId
          ? (runtimeTurnByPendingInputId.get(pendingInputId) ?? null)
          : null;
      advance(runtimeTurnId, stringField(event.payload, "messageId"));
    }

    if (!HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) continue;
    const invocationId = stringField(event.payload, "hookInvocationId");
    if (!invocationId || durableTurnByInvocationId.has(invocationId)) continue;
    const runtimeTurnId =
      runtimeTurnByInvocationId.get(invocationId) ??
      (event.turnId ? String(event.turnId) : undefined);
    const durableTurnId = runtimeTurnId ? currentTurnByRuntimeId.get(runtimeTurnId) : undefined;
    if (durableTurnId) durableTurnByInvocationId.set(invocationId, durableTurnId);
  }
  return durableTurnByInvocationId;
}

export function boundaryAnchorMessageId(event: SessionEvent): string | null {
  if (event.type === SessionEventType.TargetCompletionVerification) {
    return (
      stringField(event.payload, "anchorAssistantMessageId") ??
      stringField(event.payload, "anchorMessageId")
    );
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    return stringField(event.payload, "anchorMessageId");
  }
  if (event.type === SessionEventType.SessionForked) {
    return (
      stringField(event.payload, "targetMessageId") ?? stringField(event.payload, "anchorMessageId")
    );
  }
  return null;
}

export function insertAtDurableTurnBoundaries(input: {
  durableEvents: readonly SessionEvent[];
  trailingEvents: readonly SessionEvent[];
  turnPrefixEvents: ReadonlyMap<string, readonly SessionEvent[]>;
  turnTailEvents: ReadonlyMap<string, readonly SessionEvent[]>;
}): SessionEvent[] {
  const firstIndexByTurnId = new Map<string, number>();
  const tailIndexByTurnId = new Map<string, number>();
  input.durableEvents.forEach((event, index) => {
    if (!event.turnId) return;
    const turnId = String(event.turnId);
    if (!firstIndexByTurnId.has(turnId)) firstIndexByTurnId.set(turnId, index);
    tailIndexByTurnId.set(turnId, index);
  });
  const beforeIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnPrefixEvents) {
    const firstIndex = firstIndexByTurnId.get(turnId);
    if (firstIndex === undefined) continue;
    beforeIndex.set(firstIndex, [...(beforeIndex.get(firstIndex) ?? []), ...events]);
  }
  const afterIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnTailEvents) {
    const tailIndex = tailIndexByTurnId.get(turnId);
    if (tailIndex === undefined) continue;
    afterIndex.set(tailIndex, [...(afterIndex.get(tailIndex) ?? []), ...events]);
  }

  const merged: SessionEvent[] = [];
  input.durableEvents.forEach((event, index) => {
    merged.push(...(beforeIndex.get(index) ?? []));
    merged.push(event);
    merged.push(...(afterIndex.get(index) ?? []));
  });
  merged.push(...input.trailingEvents);
  return merged;
}

export function resequence(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, sequenceNumber: index + 1 }));
}
