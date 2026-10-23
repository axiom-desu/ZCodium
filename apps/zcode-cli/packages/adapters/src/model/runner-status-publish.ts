import type { Logger, ModelStatusSink } from "@zcode/contracts";
import type { AttemptAdmission } from "./request-admission.js";
import type { AiSdkModelTextRequest } from "./runner-runtime.js";
import { createStatusContext, publishModelStatus } from "./runner-status.js";
import { classifyModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { modelFailureStatusFields } from "./runner-failure-status.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
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

/**
 * 退避期间被取消：票据已归还，这次取消不属于任何一次尝试。
 *
 * generate 与 stream 两条重试链路共用同一投影，避免取消阶段状态分叉。
 */
export async function publishRetryBackoffCancellation(args: {
  attempt: number;
  error: unknown;
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    statusSink?: ModelStatusSink;
  };
  requestHeaders: Record<string, string>;
  statusContext: ReturnType<typeof createStatusContext>;
}): Promise<ReturnType<typeof classifyModelFailure>> {
  const failure = classifyModelFailure(args.error, args.input.request.abortSignal);
  const responseHeaders = sanitizeModelNetworkHeaders(
    getResponseHeaders(unwrapRetryError(args.error)),
  );
  await publishModelStatus(
    {
      ...args.statusContext,
      attempt: args.attempt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: Object.keys(args.requestHeaders).length,
      requestHeaders: args.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: false,
      statusCode: failure.statusCode,
      ...modelFailureStatusFields(args.error, failure, "connect"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    statusPublishOptions(args.input),
  );
  return failure;
}
