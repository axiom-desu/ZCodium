import {
  ZCODE_PROTOCOL_MISMATCH_REASON_CODE,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_RESPONSE_INVALID_REASON_CODE,
  ZCODE_PROTOCOL_VERSION,
  formatZcodeProtocolMismatchMessage,
  formatZcodeResponseInvalidMessage,
  isProtocolIdentityCompatible,
  readProtocolIdentity,
  summarizeProtocolIssues,
  zcodeProtocolMethods,
  type ZcodeProtocolIdentity,
} from "@zcode/shared";

/**
 * 响应解析失败的唯一收敛点。
 *
 * 原来 `resolveResponse` 直接 reject `ZodError`，其 message 就是 issues 的 JSON 文本，最终进入聊天
 * 消息（真机截图里那一大段）。这里把失败分成两类并只产出可读文本：
 * - 对端带 `protocol` 块且版本不兼容 → mismatch（用户需要升级，而不是自纠字段）；
 * - 其它形状不符 → response-invalid（给出最多 3 条字段摘要，帮调用方或我们定位）。
 */

export interface ZCodeProtocolResponseErrorDetails {
  method: string;
  expected: ZcodeProtocolIdentity;
  actual: ZcodeProtocolIdentity | null;
  issues: string[];
}

export class ZCodeProtocolResponseError extends Error {
  readonly code:
    | typeof ZCODE_PROTOCOL_MISMATCH_REASON_CODE
    | typeof ZCODE_PROTOCOL_RESPONSE_INVALID_REASON_CODE;

  readonly details: ZCodeProtocolResponseErrorDetails;

  constructor(params: {
    message: string;
    code: ZCodeProtocolResponseError["code"];
    details: ZCodeProtocolResponseErrorDetails;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "ZCodeProtocolResponseError";
    this.code = params.code;
    this.details = params.details;
  }

  /** 只有明确读到不同版本才报告 mismatch；形状错误不能证明版本不同。 */
  get reasonCode(): "agent_protocol_mismatch" | "agent_response_invalid" {
    return this.code === ZCODE_PROTOCOL_MISMATCH_REASON_CODE
      ? "agent_protocol_mismatch"
      : "agent_response_invalid";
  }
}

export function normalizeResponseParseFailure(params: {
  method: string;
  result: unknown;
  error: unknown;
}): ZCodeProtocolResponseError {
  const expected: ZcodeProtocolIdentity = {
    name: ZCODE_PROTOCOL_NAME,
    version: ZCODE_PROTOCOL_VERSION,
  };
  const actual = readProtocolIdentity(params.result);
  const issues = summarizeProtocolIssues(params.error);

  // 版本不匹配优先：此时字段级 issues 只是「版本不同」的下游表现，报出来会误导。
  if (actual !== null && !isProtocolIdentityCompatible(expected, actual)) {
    return new ZCodeProtocolResponseError({
      message: formatZcodeProtocolMismatchMessage({ method: params.method, expected, actual }),
      code: ZCODE_PROTOCOL_MISMATCH_REASON_CODE,
      details: { method: params.method, expected, actual, issues },
      cause: params.error,
    });
  }

  return new ZCodeProtocolResponseError({
    message: formatZcodeResponseInvalidMessage({
      method: params.method,
      expected,
      actual,
      issues,
    }),
    code: ZCODE_PROTOCOL_RESPONSE_INVALID_REASON_CODE,
    details: { method: params.method, expected, actual, issues },
    cause: params.error,
  });
}

/** Bug 修复：capabilities schema 接受未来版本，不能等 schema 失败才检查协议身份。 */
export function assertResponseProtocolIdentity(method: string, result: unknown): void {
  if (method !== zcodeProtocolMethods.runtimeCapabilities) return;
  const actual = readProtocolIdentity(result);
  const expected = { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION };
  if (actual && !isProtocolIdentityCompatible(expected, actual)) {
    throw normalizeResponseParseFailure({ method, result, error: undefined });
  }
}
