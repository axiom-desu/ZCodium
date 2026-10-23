import type { ZCodeSessionContextUsage } from "@zcode/shared";
import type {
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { readConversationFileChangesFromEvents } from "../zcode-protocol-v4/cold-file-change-summaries.js";
import type { SessionUsageSeed } from "../zcode-protocol-v4/product-projection.js";
import { SessionEventType } from "@zcode/contracts";
import type {
  DynamicWorkflowRunProgressPayload,
  EventId,
  MessageId,
  SessionEvent,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { HYDRATION_TRACE_ID } from "../zcode-protocol-v4/projection-state.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

export function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

export function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: ZCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
): SessionUsageSeed | null {
  if (!contextUsage || contextUsage.used <= 0) {
    return null;
  }
  return {
    contextWindow: {
      usedTokens: contextUsage.used,
      maxTokens: contextWindowOverride ?? null,
      autoCompactThresholdTokens: null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    },
  };
}

export async function readConversationFileChanges(
  record: ZCodeProtocolSessionRecord,
  sessionId: string,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileChangesResult> {
  const events = await record.eventStore.getEvents(sessionId as SessionId);
  return readConversationFileChangesFromEvents({
    events,
    messageIds,
    readArtifact: async (snapshotRef) =>
      (await record.app.readToolResultArtifact(snapshotRef)).content,
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

/**
 * 冷物化时把本会话的 workflow run 从 journal 回放成 `DynamicWorkflowRunProgress` 会话事件。
 *
 *   - 只对**直接命中** record 的父会话补种：经 parentID 回落到父 record 的子会话（actor
 *     transcript）不补——journal 按父会话建键，子会话的投影不该长出父会话的 run；
 *   - 内存事件里已出现过的 runId 交给 CLI 排除（本进程跑过的 run 事件全在内存 store 里，
 *     进度事件不带 turnId、不受 turn-window 淘汰），暖物化因此零重复；
 *   - 回放失败只记日志、回空：观察面绝不让冷开失败。
 *
 * 事件 id / traceId 照 transcript hydration 的合成事件；sequenceNumber 由 cold merge 统一重排。
 */

export async function replayDynamicWorkflowRunEvents(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
  memoryEvents: readonly SessionEvent[],
): Promise<SessionEvent[]> {
  if (context.sessions.get(sessionId) !== record) return [];
  const replay = record.app.replayDynamicWorkflowRuns;
  if (!replay) return [];
  const excludeRunIds = new Set<string>();
  for (const event of memoryEvents) {
    if (event.type !== SessionEventType.DynamicWorkflowRunProgress) continue;
    const runId = (event.payload as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string") excludeRunIds.add(runId);
  }
  let payloads: DynamicWorkflowRunProgressPayload[];
  try {
    payloads = await replay({ excludeRunIds });
  } catch (error) {
    context.logger?.warn("v4 hydrate dynamic workflow replay failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.v4.hydrate_workflow_replay_failed",
      module: "bootstrap.zcode_protocol",
      sessionId,
    });
    return [];
  }
  return payloads.map((payload, index) => ({
    id: `dwf-replay-${index + 1}` as EventId,
    sessionId: sessionId as SessionId,
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(0),
    traceId: HYDRATION_TRACE_ID as TraceId,
    sequenceNumber: 0,
    payload,
  }));
}

export async function resolveConversationBackingRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ZCodeProtocolSessionRecord | undefined> {
  const direct = context.sessions.get(sessionId);
  if (direct) return direct;

  // 运行中 subagent 有独立 child event log，但没有独立 bootstrap record。
  // 文件摘要只需要共享 event/artifact store，因此通过持久化 parentID 找到父 record 作为
  // artifact reader，读取事件时仍显式使用 childSessionId；不能为了只读查询 cold resume
  // 第二个 child runtime。
  const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
  const parentSessionId = stored?.parentID ? String(stored.parentID) : null;
  return parentSessionId ? context.sessions.get(parentSessionId) : undefined;
}

export async function previewConversationFileRewind(
  record: ZCodeProtocolSessionRecord,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileRewindPreviewResult> {
  return record.app.runtime.previewWorkspaceFileRewind({
    targetMessageIds: messageIds as MessageId[],
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}
