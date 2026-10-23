import type { Logger } from "@zcode/contracts";
import { ModelTransportKind as ModelTransportKindValue } from "@zcode/contracts";
import type { AttemptAdmission } from "./request-admission.js";
import type { AiSdkModelTextRequest } from "./runner-runtime.js";
import { createStatusContext, publishModelStatus } from "./runner-status.js";
import { statusPublishOptions } from "./runner-status-publish.js";
import { retryBudgetMaxAttempts } from "./retry-budget.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import type { StreamRunInput } from "./runner-stream-attempt.js";
import { admitAttempt } from "./request-admission.js";
import { admissionWaitPublishers } from "./runner-status.js";
import { classifyModelFailure } from "./failure-classifier.js";
import { modelFailureStatusFields } from "./runner-failure-status.js";
import { toAdapterError } from "./runner-retry.js";

export async function acquireStreamAdmission(args: {
  input: StreamRunInput;
  statusContext: ReturnType<typeof createStatusContext>;
  attempt: number;
  startedAt: number;
  streamOutputCommitted: boolean;
  onAdmissionFailure: () => void;
}): Promise<AttemptAdmission> {
  const { input, statusContext, attempt, startedAt, streamOutputCommitted } = args;
  try {
    return await admitAttempt({
      admission: input.request.modelRequestAdmission,
      model: {
        providerId: String(input.resolved.providerId),
        modelId: String(input.resolved.modelId),
      },
      signal: input.request.abortSignal,
      ...admissionWaitPublishers(statusContext, attempt, statusPublishOptions(input)),
    });
  } catch (admitError) {
    args.onAdmissionFailure();
    const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
    await publishModelStatus(
      {
        ...statusContext,
        attempt,
        durationMs: Date.now() - startedAt,
        message: admitFailure.message,
        reason: admitFailure.reason,
        requestHeaderCount: 0,
        requestHeaders: {},
        retryable: false,
        statusCode: admitFailure.statusCode,
        streamOutputCommitted,
        ...modelFailureStatusFields(admitError, admitFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        ...statusPublishOptions(input),
      },
    );
    throw toAdapterError(admitError, admitFailure, statusContext, attempt, {
      errorPhase: "connect",
    });
  }
}

// 成功收口只发布状态，不持有流事实；返回是否发布 completed（供 finally 使用）。

export interface StreamAttemptState {
  awaitIteratorClose: boolean;
  terminalStatusPublished: boolean;
}

export async function publishStreamStalled(args: {
  admission: AttemptAdmission;
  attempt: number;
  error: { idleMs: number; message: string; timeoutMs: number };
  input: StreamRunInput;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  statusContext: ReturnType<typeof createStatusContext>;
}): Promise<void> {
  await publishModelStatus(
    {
      ...args.statusContext,
      attempt: args.attempt,
      idleMs: args.error.idleMs,
      message: args.error.message,
      requestHeaderCount: args.requestHeaderCount,
      requestHeaders: args.requestHeaders,
      timeoutMs: args.error.timeoutMs,
      timestamp: new Date().toISOString(),
      type: "model_stream_stalled",
    },
    statusPublishOptions(args.input, args.admission),
  );
}

// 签名只对生成它的 thinking block 有效：只返回本次请求副本，不写回 canonical history。
export function repairStreamThinkingSignature(args: {
  attempt: number;
  error: unknown;
  logger?: Logger;
  maxAttempts: number;
  messages: AiSdkModelTextRequest["messages"];
  providerKind: string;
  requestId: string;
  signatureRepairAttempted: boolean;
}): AiSdkModelTextRequest["messages"] | undefined {
  if (args.signatureRepairAttempted || args.providerKind !== "anthropic") {
    return undefined;
  }
  const repairedMessages = repairReasoningHistoryAfterSignatureRejection(args.messages, args.error);
  if (!repairedMessages) return undefined;
  args.logger?.warn("Retrying model stream after thinking signature rejection", {
    attempt: args.attempt,
    event: "model.reasoning_signature_repair.retry",
    maxAttempts: args.maxAttempts + 1,
    nextAttempt: args.attempt + 1,
    requestId: args.requestId,
    status: "waiting",
  });
  return repairedMessages;
}

export function createStreamRunContext(input: StreamRunInput): {
  baseStatusContext: ReturnType<typeof createStatusContext>;
  retryBudget: AiSdkModelTextRequest["modelRetryBudget"];
  statusMaxAttempts: (extraAttempts: number) => number;
} {
  // 重试预算档位：只放宽瞬态失败的放弃条件；
  // `emittedRetryBoundaryEvent` 之后不重试的规则不变。状态事件 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Sse,
  });
  return { baseStatusContext, retryBudget, statusMaxAttempts };
}
