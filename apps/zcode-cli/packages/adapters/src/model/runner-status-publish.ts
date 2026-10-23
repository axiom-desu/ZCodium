import type { Logger, ModelStatusSink } from "@zcode/contracts";
import type { AttemptAdmission } from "./request-admission.js";
import type { AiSdkModelTextRequest } from "./runner-runtime.js";
import { createStatusContext, publishModelStatus } from "./runner-status.js";
import type { classifyModelFailure } from "./failure-classifier.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

// 重试状态发布在 stream 与 generate 两条链路共用：唯一 owner 是 runner-status，
// 这里只做事件字段投影，不持有任何重试状态。
export function statusPublishOptions(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    statusSink?: ModelStatusSink;
  },
  admission?: AttemptAdmission,
) {
  return {
    logger: input.logger,
    requestStatusSink: input.request.statusSink,
    statusSink: input.statusSink,
    // 本次尝试的准入票据也是它的状态事件汇。
    ...(admission?.ticket === undefined ? {} : { admissionTicket: admission.ticket }),
  };
}

export async function publishRetryScheduledStatus(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    retry?: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  },
  statusContext: ReturnType<typeof createStatusContext>,
  attempt: number,
  delayMs: number,
  failure: ReturnType<typeof classifyModelFailure>,
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
  admission?: AttemptAdmission,
): Promise<void> {
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      delayMs,
      message: failure.message,
      nextAttempt: attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(requestHeaders).length,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      statusCode: failure.statusCode,
      errorCode: failure.code,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    statusPublishOptions(input, admission),
  );
}
