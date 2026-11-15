// 流结束后的 provider finish 诊断：超窗与可疑空完成的告警/收口。
// 从 model.ts 拆出，避免 model.ts 继续增长；语义与拆分前逐字一致。
import type { Model, ModelUsage } from "../deps.js";
import { traceContextToLogContext } from "../deps.js";
import {
  buildSuspiciousEmptyDiagnostics,
  finalizeSuspiciousEmptyModelResult,
  isContextExceededFinishReason,
  isSuspiciousEmptyModelResult,
  readRawFinishReason,
} from "../helpers/index.js";
import { isOutputTokenLimitFinishReason } from "./turn-output-token-continuation.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TraceContext } from "@zcode/contracts";

export function reportModelStreamFinishDiagnostics(
  runtime: AgentRuntimeInternal,
  input: {
    finishReason: string;
    providerMetadata: Record<string, unknown> | undefined;
    model: Pick<Model, "providerId" | "modelId">;
    textLength: number;
    toolCallCount: number;
    traceContext: TraceContext;
    usage: ModelUsage;
  },
): void {
  const rawFinishReason = readRawFinishReason(input.providerMetadata);
  const outputTokenLimit = isOutputTokenLimitFinishReason(input.finishReason, rawFinishReason);
  const contextExceeded =
    input.toolCallCount === 0 &&
    !outputTokenLimit &&
    isContextExceededFinishReason(input.finishReason, rawFinishReason);
  if (contextExceeded) {
    // 这里若把 HTTP 200 + finish metadata 提前抛成流异常，会先被通用断流恢复接管，
    // 从而绕过 turn 层的 Reactive Compact。保留原始结果，由 turn 层统一处理超窗语义。
    runtime.logger?.warn("Model stream ended with provider context overflow", {
      ...traceContextToLogContext(input.traceContext),
      event: "model.runtime.stream.context_exceeded",
      finishReason: input.finishReason,
      module: "core.runtime",
      modelProviderId: input.model.providerId,
      modelId: input.model.modelId,
      rawFinishReason,
      textLength: input.textLength,
      toolCallCount: input.toolCallCount,
    });
  }

  // 流在只发出 start/prelude 后以 finishReason=unknown 结束时，会被记到 turn-model-step
  // 的 suspicious empty。这里在返回 result 前再扫一遍 providerMetadata/空 completion。
  if (
    !contextExceeded &&
    !outputTokenLimit &&
    isSuspiciousEmptyModelResult(
      input.finishReason,
      input.textLength,
      input.toolCallCount,
      input.usage,
    )
  ) {
    // zcode-plan 常返回 HTTP 200 空 SSE，需在抛错前打出 finish/providerMetadata 摘要，避免只能看到 UI 泛化文案。
    runtime.logger?.warn("Model stream ended with suspicious empty completion", {
      ...traceContextToLogContext(input.traceContext),
      event: "model.runtime.stream.suspicious_empty",
      module: "core.runtime",
      modelProviderId: input.model.providerId,
      modelId: input.model.modelId,
      textLength: input.textLength,
      toolCallCount: input.toolCallCount,
      ...buildSuspiciousEmptyDiagnostics({
        finishReason: input.finishReason,
        providerMetadata: input.providerMetadata,
        rawFinishReason,
      }),
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason: input.finishReason,
      model: input.model,
      providerMetadata: input.providerMetadata,
      rawFinishReason,
    });
  }
}
