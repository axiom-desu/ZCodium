import { SessionEventType, isCoreError, type MessageId, type SessionEvent } from "../deps.js";
import type { TraceContext } from "@zcode/contracts";

/**
 * Usage 事实的纯投影层。
 *
 * 这些函数只把 runtime 已收集的事件/错误映射成 usage store 的行字段，不读写 runtime 状态、
 * 不发起 IO；store 选择与写入仍在 `usage-observability.ts`，保持原 owner 与事件次序。
 */
/** modelUsageId 只需要稳定标识与来源；调用方保留自己的完整 input 类型。 */
interface ModelUsageIdentity {
  assistantMessageId?: MessageId;
  attemptIndex?: number;
  querySource: string;
  startedAt: number;
  traceContext: TraceContext;
}

export function modelUsageId(input: ModelUsageIdentity): string {
  const logicalId =
    input.assistantMessageId ??
    input.traceContext.spanId ??
    `${input.querySource}_${input.startedAt}`;
  return `usage_model_${input.querySource}_${logicalId}_${input.attemptIndex ?? 0}`;
}

export function toolUsageId(sessionId: string, toolCallId: string): string {
  return `usage_tool_${sessionId}_${toolCallId}`;
}

export function modelNetworkEvents(events: readonly SessionEvent[]) {
  return events
    .filter((event) => event.type === SessionEventType.ModelNetworkStatus)
    .map((event) => event.payload)
    .filter(
      (
        payload,
      ): payload is {
        type: string;
        reason?: string;
        retryable?: boolean;
        message?: string;
      } => Boolean(payload && typeof payload === "object" && "type" in payload),
    );
}

export function firstModelTokenAt(
  events: readonly SessionEvent[],
  startIndex: number,
): number | undefined {
  for (const event of events.slice(startIndex)) {
    if (event.type !== SessionEventType.ModelStreaming) continue;
    const payload = event.payload as { delta?: string; kind?: string };
    if (
      (payload.kind === "text_delta" || payload.kind === "reasoning_delta") &&
      payload.delta &&
      payload.delta.length > 0
    ) {
      return event.timestamp.getTime();
    }
  }
  return undefined;
}

export function errorInfoFor(
  error: unknown,
  failedNetworkEvent: { reason?: string; retryable?: boolean; message?: string } | undefined,
): { code?: string; message?: string; retryable?: boolean; type?: string } {
  if (isCoreError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      type: error.type,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      retryable: failedNetworkEvent?.retryable,
      type: failedNetworkEvent?.reason ?? error.name,
    };
  }
  if (failedNetworkEvent) {
    return {
      message: failedNetworkEvent.message,
      retryable: failedNetworkEvent.retryable,
      type: failedNetworkEvent.reason,
    };
  }
  return {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
