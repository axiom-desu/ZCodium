import {
  ApiError,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
  resolveModelProviderFamilyIdByBaseURL,
  type ApiClient,
  type ApiRequestInit,
  type CodingPlanQuotaRequest,
  type CodingPlanQuotaSnapshot,
  type UsageQuotaLimit,
} from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";

/**
 * Coding Plan 剩余额度：用用户自己的 API Key 查询官方 monitor 接口。
 *
 * 这里刻意不引入任何账号态：上游同一接口的鉴权就是裸 API Key（不加 Bearer），
 * 不消费业务 token 或 JWT，因此额度展示不构成新的官方服务依赖。
 */

const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const REQUEST_TIMEOUT_MS = 15_000;

export type CodingPlanQuotaErrorCode =
  | "unsupported-provider"
  | "missing-api-key"
  | "request-failed"
  | "invalid-response";

export interface CodingPlanQuotaFailure {
  readonly success: false;
  readonly error: { readonly code: CodingPlanQuotaErrorCode; readonly message: string };
}

export type CodingPlanQuotaResult =
  | { readonly success: true; readonly snapshot: CodingPlanQuotaSnapshot }
  | CodingPlanQuotaFailure;

interface QuotaEnvelope {
  code?: number;
  msg?: string;
  message?: string;
  success?: boolean;
  data?: QuotaPayload | null;
}

interface QuotaPayload {
  level?: string;
  limits?: Array<{
    type?: string;
    unit?: number;
    number?: number;
    usage?: number;
    currentValue?: number;
    remaining?: number;
    percentage?: number;
    nextResetTime?: number;
    usageDetails?: Array<{ modelCode?: string; displayName?: string; usage?: number }>;
  }>;
}

/**
 * 端点按 family 选 domain：zai 的额度与业务登录同域，bigmodel 走 API 域。
 * 两者路径一致；family 无法判定时不猜，直接拒绝。
 */
export function resolveCodingPlanQuotaUrl(
  request: Pick<CodingPlanQuotaRequest, "baseUrl">,
  env: NodeJS.ProcessEnv = process.env,
): { family: "zai" | "bigmodel"; url: string } | null {
  const family = resolveModelProviderFamilyIdByBaseURL(request.baseUrl);
  if (!family) return null;
  return {
    family,
    url:
      family === "zai"
        ? buildRuntimeZaiBusinessUrl(env, QUOTA_PATH)
        : buildBigModelApiUrl(env, QUOTA_PATH),
  };
}

/** monitor 接口要求 authorization 直接携带完整凭据，加 Bearer 前缀会被判为非法。 */
export function buildCodingPlanQuotaHeaders(apiKey: string): Record<string, string> {
  return { authorization: apiKey.trim() };
}

function isSuccessfulEnvelope(envelope: QuotaEnvelope): boolean {
  if (envelope.success === false) return false;
  if (envelope.code !== undefined && ![0, 200].includes(envelope.code)) return false;
  return true;
}

export function normalizeQuotaLimits(payload: QuotaPayload | null | undefined): UsageQuotaLimit[] {
  const limits = payload?.limits;
  if (!Array.isArray(limits)) return [];
  return limits
    .filter((limit) => typeof limit.type === "string" && limit.type.length > 0)
    .map((limit) => ({
      type: limit.type ?? "",
      ...(typeof limit.unit === "number" ? { unit: limit.unit } : {}),
      ...(typeof limit.number === "number" ? { number: limit.number } : {}),
      ...(typeof limit.usage === "number" ? { usage: limit.usage } : {}),
      ...(typeof limit.currentValue === "number" ? { currentValue: limit.currentValue } : {}),
      ...(typeof limit.remaining === "number" ? { remaining: limit.remaining } : {}),
      ...(typeof limit.percentage === "number" ? { percentage: limit.percentage } : {}),
      ...(typeof limit.nextResetTime === "number" ? { nextResetTime: limit.nextResetTime } : {}),
      usageDetails: Array.isArray(limit.usageDetails)
        ? limit.usageDetails.flatMap((detail) =>
            typeof detail.modelCode === "string"
              ? [
                  {
                    modelCode: detail.modelCode,
                    ...(typeof detail.displayName === "string"
                      ? { displayName: detail.displayName }
                      : {}),
                    usage: typeof detail.usage === "number" ? detail.usage : 0,
                  },
                ]
              : [],
          )
        : [],
    }));
}

/** 主额度口径与上游一致：优先 5 小时桶，其次第一个带 remaining 的桶。 */
export function pickPrimaryQuotaLimit(limits: readonly UsageQuotaLimit[]): UsageQuotaLimit | null {
  return (
    limits.find((limit) => limit.type === "TIME_LIMIT") ??
    limits.find((limit) => typeof limit.remaining === "number") ??
    limits[0] ??
    null
  );
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    // 响应体可能夹带请求信息，只回传状态码。
    return error.status ? `HTTP ${error.status}` : "request failed";
  }
  return "request failed";
}

export async function fetchCodingPlanQuota(options: {
  readonly apiClient: ApiClient;
  readonly request: CodingPlanQuotaRequest;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<CodingPlanQuotaResult> {
  const apiKey = options.request.apiKey.trim();
  if (!apiKey) {
    return { success: false, error: { code: "missing-api-key", message: "api key is empty" } };
  }
  const target = resolveCodingPlanQuotaUrl(options.request, options.env);
  if (!target) {
    return {
      success: false,
      error: { code: "unsupported-provider", message: "provider family is unknown" },
    };
  }

  const init: ApiRequestInit = {
    method: "GET",
    headers: buildCodingPlanQuotaHeaders(apiKey),
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let payload: QuotaEnvelope;
  try {
    payload = await readApiJson<QuotaEnvelope>(options.apiClient, target.url, init);
  } catch (error) {
    return { success: false, error: { code: "request-failed", message: describeFailure(error) } };
  }

  if (!isSuccessfulEnvelope(payload)) {
    // 业务失败不能退化成"零额度"，否则用户会误以为套餐已用完。
    return {
      success: false,
      error: {
        code: "invalid-response",
        message: payload.msg ?? payload.message ?? "quota request was rejected",
      },
    };
  }

  const limits = normalizeQuotaLimits(payload.data);
  return {
    success: true,
    snapshot: {
      fetchedAt: Date.now(),
      family: target.family,
      level: payload.data?.level?.trim() || null,
      limits,
      remaining: pickPrimaryQuotaLimit(limits),
    },
  };
}
