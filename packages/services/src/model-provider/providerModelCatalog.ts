import { ApiError, type ApiClient, type ApiRequestInit } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";

/** 与 provider api.type 对齐的模型目录协议；账号型 Provider 不走这里。 */
export type ProviderModelCatalogApiType =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses"
  | "google-generative-ai";

export type ProviderModelCatalogErrorCode =
  | "provider-unavailable"
  | "unsupported-access"
  | "base-url-missing"
  | "api-key-missing"
  | "request-failed"
  | "empty-catalog";

export interface ProviderModelCatalogRequest {
  readonly apiType: ProviderModelCatalogApiType;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>> | null;
}

export interface ProviderModelCatalogSuccess {
  readonly success: true;
  readonly modelIds: readonly string[];
  /** primary=首选端点直接成功；fallback=首选失败后换路径重试成功。 */
  readonly source: "primary" | "fallback";
}

export interface ProviderModelCatalogFailure {
  readonly success: false;
  readonly error: {
    readonly code: ProviderModelCatalogErrorCode;
    readonly message: string;
  };
}

export type ProviderModelCatalogResult = ProviderModelCatalogSuccess | ProviderModelCatalogFailure;

/** Service 注入的拉取能力；由宿主 apiClient 装配，Renderer 不直接发请求。 */
export type ProviderModelCatalogLister = (
  request: ProviderModelCatalogRequest,
) => Promise<ProviderModelCatalogResult>;

interface ProviderModelCatalogAttempt {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 目录异常放大时保护 UI 与后续逐条添加，不追求穷尽。 */
const MAX_MODEL_IDS = 1000;
const ANTHROPIC_VERSION = "2023-06-01";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * 候选端点按 api.type 生成，不做“猜路径”补全：只有主路径和同一 base 的
 * 另一种路径两个候选，主路径挂了才试 fallback（见 spec）。
 */
export function buildProviderModelCatalogAttempts(
  request: ProviderModelCatalogRequest,
): readonly [ProviderModelCatalogAttempt, ProviderModelCatalogAttempt] {
  const base = normalizeBaseUrl(request.baseUrl);
  // Gemini 原生目录只认 x-goog-api-key；发送 Bearer 或 x-api-key 会被判为未鉴权。
  const authHeaders: Record<string, string> =
    request.apiType === "anthropic-messages"
      ? { "x-api-key": request.apiKey, "anthropic-version": ANTHROPIC_VERSION }
      : request.apiType === "google-generative-ai"
        ? { "x-goog-api-key": request.apiKey }
        : { Authorization: `Bearer ${request.apiKey}` };
  // 自定义 headers 同名覆盖内置鉴权头：网关把密钥放在自定义头时不能让内置头把它顶掉。
  const headers = { ...authHeaders, ...request.headers };
  const paths: readonly [string, string] = resolveCatalogPaths(request.apiType, base);
  return [
    { url: `${base}${paths[0]}`, headers },
    { url: `${base}${paths[1]}`, headers },
  ];
}

/**
 * 候选路径按 api.type 决定。
 *
 * Gemini 的版本段通常在 baseUrl 里（.../v1beta），此时再拼一次会得到
 * /v1beta/v1beta/models；带版本段时主备同路径即可——重试同一路径仍能覆盖
 * 瞬时失败，不会制造一个必然 404 的假 fallback。
 */
function resolveCatalogPaths(
  apiType: ProviderModelCatalogApiType,
  base: string,
): readonly [string, string] {
  if (apiType === "anthropic-messages") {
    return ["/v1/models", "/models"];
  }
  if (apiType === "google-generative-ai") {
    const hasVersionSegment = /\/v\d+(?:alpha|beta)?\d*$/i.test(base);
    return hasVersionSegment ? ["/models", "/models"] : ["/models", "/v1beta/models"];
  }
  return ["/models", "/v1/models"];
}

function collectModelIds(payload: unknown): string[] {
  const entries = (() => {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === "object") {
      const record = payload as { data?: unknown; models?: unknown };
      if (Array.isArray(record.data)) return record.data;
      if (Array.isArray(record.models)) return record.models;
    }
    return [];
  })();
  const modelIds: string[] = [];
  for (const entry of entries) {
    // Gemini 原生目录用 name: "models/gemini-2.5-pro"；必须剥前缀，否则用户看到的 id
    // 与手填/其它来源不一致，选中后会被当成不同模型。
    const rawId =
      typeof entry === "string"
        ? entry
        : ((entry as { id?: unknown; name?: unknown })?.id ?? (entry as { name?: unknown })?.name);
    if (typeof rawId !== "string") continue;
    const trimmed = rawId.trim().replace(/^models\//, "");
    if (!trimmed || modelIds.includes(trimmed)) continue;
    modelIds.push(trimmed);
    if (modelIds.length >= MAX_MODEL_IDS) break;
  }
  return modelIds;
}

/** 空目录按失败处理：错误路径常常返回 200 + 空 data，必须让 fallback 有机会。 */
function isUsableCatalog(modelIds: readonly string[]): boolean {
  return modelIds.length > 0;
}

function describeAttemptError(error: unknown): string {
  if (error instanceof ApiError) {
    // 只回传状态：响应体可能是对端报文，也可能夹带请求信息，不作为用户文案。
    return error.status ? `HTTP ${error.status}` : "request failed";
  }
  return "request failed";
}

export async function fetchProviderModelCatalog(options: {
  readonly apiClient: ApiClient;
  readonly request: ProviderModelCatalogRequest;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ProviderModelCatalogResult> {
  const attempts = buildProviderModelCatalogAttempts(options.request);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let firstFailure: ProviderModelCatalogFailure | null = null;

  for (const [index, attempt] of attempts.entries()) {
    const init: ApiRequestInit = {
      method: "GET",
      headers: attempt.headers,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    try {
      const payload = await readApiJson<unknown>(options.apiClient, attempt.url, init);
      const modelIds = collectModelIds(payload);
      if (!isUsableCatalog(modelIds)) {
        if (!firstFailure) {
          firstFailure = {
            success: false,
            error: { code: "empty-catalog", message: "empty catalog" },
          };
        }
        continue;
      }
      return { success: true, modelIds, source: index === 0 ? "primary" : "fallback" };
    } catch (error) {
      if (!firstFailure) {
        firstFailure = {
          success: false,
          error: { code: "request-failed", message: describeAttemptError(error) },
        };
      }
    }
  }

  return (
    firstFailure ?? { success: false, error: { code: "empty-catalog", message: "empty catalog" } }
  );
}

/** 供 ProviderRuntime 注入：只暴露请求语义，不把 ApiClient 泄漏给 Service 其它方法。 */
export function createProviderModelCatalogLister(options: {
  readonly apiClient: ApiClient;
  readonly timeoutMs?: number;
}): ProviderModelCatalogLister {
  return async (request) =>
    fetchProviderModelCatalog({
      apiClient: options.apiClient,
      request,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
}
