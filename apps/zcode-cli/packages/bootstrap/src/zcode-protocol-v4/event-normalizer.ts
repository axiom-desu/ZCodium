// live SessionEvent 与 cold hydration 合成事件的唯一字段解释入口。
//
// 用户意图一侧（kind/text/来源/附件/选区引用）按语义拆到 conversation-canonical-intent.ts；
// 这里保留公开入口 `normalizeConversationEvent` 与 assistant 流/passthrough 的组装，
// 并对上游模块继续导出同一批 canonical 类型。
import type {
  ModelStreamingPayload,
  SessionEvent,
  TurnStartedPayload,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  normalizeTurnStarted,
  type CanonicalConversationFactBase,
  type CanonicalUserIntentFact,
  type ConversationNormalizationDiagnostic,
} from "./conversation-canonical-intent.js";

export type {
  CanonicalConversationFactBase,
  CanonicalUserIntentFact,
  ConversationNormalizationDiagnostic,
} from "./conversation-canonical-intent.js";

export interface CanonicalModelStream {
  kind: ModelStreamingPayload["kind"];
  delta: string;
  done: boolean;
  assistantResponseId?: string;
  transcriptPartId?: string;
  toolCallId?: ModelStreamingPayload["toolCallId"];
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export interface CanonicalAssistantSegmentFact extends CanonicalConversationFactBase {
  semanticKind: "assistantSegment";
  visibility: "visible";
  origin: "assistant";
  stream: CanonicalModelStream;
}

export interface CanonicalPassthroughFact extends CanonicalConversationFactBase {
  semanticKind: "passthrough";
  sourceCommandId?: string;
}

export type CanonicalConversationFact =
  | CanonicalUserIntentFact
  | CanonicalAssistantSegmentFact
  | CanonicalPassthroughFact;

interface NormalizeConversationEventContext {
  productTurnId?: string;
  openAssistantSegments?: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>>;
}

export interface CanonicalOpenSegmentIdentity {
  entityId: string;
  transcriptMessageId: string | null;
}

/**
 * live SessionEvent 与 cold hydration 合成事件的唯一字段解释入口。
 *
 * 过去 ProductProjection 直接从 raw payload 分别猜 messageId、origin 与
 * visibility；cold 少一个字段时可见 row 仍会生成，但命令 target 缺失。normalizer
 * 先生成自包含 canonical fact，让 row、target、actions 使用同一份身份事实。
 */
export function normalizeConversationEvent(
  event: SessionEvent,
  context: NormalizeConversationEventContext = {},
): CanonicalConversationFact {
  const runtimeTurnId = runtimeTurnIdOf(event);
  const productTurnId = context.productTurnId ?? runtimeTurnId;
  if (event.type === SessionEventType.TurnStarted) {
    return normalizeTurnStarted(event, event.payload as TurnStartedPayload, {
      runtimeTurnId,
      productTurnId,
    });
  }
  if (event.type === SessionEventType.ModelStreaming) {
    return normalizeModelStreaming(event, event.payload as ModelStreamingPayload, {
      runtimeTurnId,
      productTurnId,
      openAssistantSegments: context.openAssistantSegments,
    });
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    const payload = event.payload as Record<string, unknown>;
    const operationId =
      typeof payload.operationId === "string" && payload.operationId.length > 0
        ? payload.operationId
        : String(event.id);
    const transcriptMessageId =
      typeof payload.messageId === "string" && payload.messageId.length > 0
        ? payload.messageId
        : null;
    return {
      semanticKind: "passthrough",
      event,
      entityId: operationId,
      productTurnId,
      runtimeTurnId,
      transcriptMessageId,
      visibility: "visible",
      origin: "system",
      placement: { lane: "assistantWork", relation: "withinProductTurn" },
      diagnostics: [],
      ...(typeof payload.sourceCommandId === "string"
        ? { sourceCommandId: payload.sourceCommandId }
        : {}),
    };
  }
  return {
    semanticKind: "passthrough",
    event,
    entityId: String(event.id),
    productTurnId,
    runtimeTurnId,
    transcriptMessageId: null,
    visibility: "stateOnly",
    origin: "system",
    placement: { lane: "stateOnly", relation: "none" },
    diagnostics: [],
  };
}

function normalizeModelStreaming(
  event: SessionEvent,
  payload: ModelStreamingPayload,
  ids: {
    runtimeTurnId: string;
    productTurnId: string;
    openAssistantSegments: NormalizeConversationEventContext["openAssistantSegments"];
  },
): CanonicalAssistantSegmentFact {
  const lane = assistantStreamLane(payload.kind);
  const openSegment =
    lane === "text" || lane === "reasoning" ? ids.openAssistantSegments?.[lane] : undefined;
  const inheritsOpenSegment = !isAssistantStreamStart(payload.kind);
  const inheritedSegment = inheritsOpenSegment ? openSegment : undefined;
  const transcriptMessageId = payload.assistantMessageId
    ? String(payload.assistantMessageId)
    : (inheritedSegment?.transcriptMessageId ?? null);
  const identityRequired =
    payload.kind === "text_start" || (payload.kind === "text_delta" && !transcriptMessageId);
  const diagnostics: ConversationNormalizationDiagnostic[] =
    identityRequired && !transcriptMessageId
      ? [
          {
            code: "normalizer.assistant.missingTranscriptMessageId",
            eventId: String(event.id),
          },
        ]
      : [];
  const transcriptPartId = payload.partId ? String(payload.partId) : undefined;
  const toolEntityId = payload.toolCallId ? String(payload.toolCallId) : undefined;
  const intrinsicEntityId =
    lane === "tool" ? (toolEntityId ?? transcriptPartId) : (transcriptPartId ?? toolEntityId);
  return {
    semanticKind: "assistantSegment",
    event,
    entityId:
      transcriptMessageId ??
      inheritedSegment?.entityId ??
      intrinsicEntityId ??
      `legacy:assistant:${String(event.sessionId)}:${ids.runtimeTurnId}:${transcriptPartId ?? String(event.id)}`,
    productTurnId: ids.productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: "visible",
    origin: "assistant",
    placement: { lane: "assistantWork", relation: "withinProductTurn" },
    diagnostics,
    stream: {
      kind: payload.kind,
      delta: payload.delta,
      done: payload.done,
      ...(transcriptMessageId ? { assistantResponseId: transcriptMessageId } : {}),
      ...(transcriptPartId ? { transcriptPartId } : {}),
      ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
      // 空字符串是空工具名恢复的有效原始事实；truthy 判断会把它抹成
      // undefined，导致后续产品态过滤误把该调用物化成一个空名工具行。
      ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.providerExecuted !== undefined
        ? { providerExecuted: payload.providerExecuted }
        : {}),
    },
  };
}

function assistantStreamLane(
  kind: ModelStreamingPayload["kind"],
): "text" | "reasoning" | "tool" | "other" {
  if (kind?.startsWith("text_")) return "text";
  if (kind?.startsWith("reasoning_")) return "reasoning";
  if (kind?.startsWith("tool_") || kind === "tool_call") return "tool";
  return "other";
}

function isAssistantStreamStart(kind: ModelStreamingPayload["kind"]): boolean {
  return kind === "text_start" || kind === "reasoning_start" || kind === "tool_input_start";
}

function runtimeTurnIdOf(event: SessionEvent): string {
  if (event.turnId) return String(event.turnId);
  if (event.type === SessionEventType.TurnStarted) {
    const payload = event.payload as TurnStartedPayload;
    return `turn-${payload.turnNumber}`;
  }
  return "turn-unknown";
}
