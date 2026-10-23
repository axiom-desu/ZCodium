import type { ModelStatusSink } from "./status-contracts.js";

export type JsonSchema = Record<string, unknown>;

export type ModelProviderId = string & { readonly __brand: "ModelProviderId" };
export type ModelId = string & { readonly __brand: "ModelId" };

export const ModelRequestSessionType = {
  Main: "main",
  Other: "other",
  Subagent: "subagent",
} as const;

/**
 * 模型请求的重试预算档位（runtime-only）。
 * - `default`：adapter 构造时解析出的 maxAttempts（默认 10 次重试）。
 * - `unbounded`：**瞬态**失败无上限重试（退避曲线不变、封顶 60s 后无限探测），永久失败照旧立即抛。
 *   给 workflow actor（taskType workflow_child / nested_workflow_child）使用：模型错误绝不是
 *   workflow 错误，唯一出口是用户 cancel。
 */
export const ModelRetryBudget = {
  Default: "default",
  Unbounded: "unbounded",
} as const;

export type ModelRetryBudget = (typeof ModelRetryBudget)[keyof typeof ModelRetryBudget];

/**
 * 一次模型请求尝试的准入票据（runtime-only）。
 *
 * 它同时是**这一次尝试**的状态事件汇：runner 把该尝试的 ModelNetworkStatus 事件
 * （`model_request_started` / `model_request_completed` / `model_request_failed` /
 * `model_retry_scheduled`）原样也投递给它，治理器据此判定这次请求的结果（成功 / 限流 / 瞬态失败 /
 * 终结），不需要 runner 在每个失败分支上另写一遍结果。`release()` 是兜底：尝试无论如何结束（成功、
 * 抛出、消费者提前放弃流）runner 都在 finally 里调一次；未见终结事件即按终结处理。**幂等**。
 */
export interface ModelRequestAdmissionTicket extends ModelStatusSink {
  release(): void;
}

/**
 * 模型请求的准入端口（runtime-only）。runner 在**每一次尝试发出前**先试同步快路径
 * `tryAcquire`，未命中再 `acquire` 排队；拿到票据后才发请求；尝试结束即 `release`，退避 sleep 期间
 * 不持票——所以进程级并发 cap 约束的是 provider 真正看到的在飞请求数。`signal` 被 abort 时
 * `acquire` 以 `signal.reason` reject。
 *
 * `tryAcquire` 未命中是 runner 发 `model_request_queued` / `model_request_admitted` 的唯一依据
 * 没有快路径的实现 runner 无法分辨「排了队」与「立即放行」，一律不发这两条事件。
 *
 * 端口绑定在 runtime 的模型工厂上：runtime 交出的每一个模型句柄——turn step、工具内部
 * 的模型调用、压缩、标题 sidecar——都带它；缺席即不设闸门（runner 行为逐字不变）。主代理拿的是
 * 治理器的 observer 实现：`tryAcquire` 总命中、只喂信号。
 */
export interface ModelRequestAdmission {
  /** 同步快路径：闸门开着且无人排队即给票；否则 undefined，runner 转 `acquire` 并报排队。 */
  tryAcquire?(input: { model: ModelRequestTarget }): ModelRequestAdmissionTicket | undefined;
  acquire(input: {
    model: ModelRequestTarget;
    signal?: AbortSignal;
  }): Promise<ModelRequestAdmissionTicket>;
}

/**
 * 准入端口看到的模型身份：配额键的最小事实。既不是 Selection（那是执行意图），也不是
 * Active Model（那带完整配置）——treaty 只要 provider/model 两段。
 */
export interface ModelRequestTarget {
  providerId: string;
  modelId: string;
}

export type ModelRequestSessionType =
  (typeof ModelRequestSessionType)[keyof typeof ModelRequestSessionType];

export const ModelErrorCode = {
  InvalidModelSelection: "invalid_model_selection",
  ModelConfigMissing: "model_config_missing",
  ProviderNotFound: "provider_not_found",
  ProviderNotConfigured: "provider_not_configured",
  ModelNotFound: "model_not_found",
  InvalidModelRequest: "invalid_model_request",
  InvalidModelResponse: "invalid_model_response",
  ModelRequestFailed: "model_request_failed",
  ModelRequestAuthMissing: "model_request_auth_missing",
  ModelRequestCancelled: "model_request_cancelled",
  ModelRequestTimeout: "model_request_timeout",
  ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",
} as const;

export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

export const ModelTransportKind = {
  Http: "http",
  Sse: "sse",
  WebSocket: "websocket",
} as const;

export type ModelTransportKind = (typeof ModelTransportKind)[keyof typeof ModelTransportKind];

export const ModelRetryReason = {
  RateLimited: "rate_limited",
  ProviderOverloaded: "provider_overloaded",
  ServerError: "server_error",
  NetworkError: "network_error",
  Timeout: "timeout",
  StreamIdleTimeout: "stream_idle_timeout",
  StaleConnection: "stale_connection",
  AuthRefresh: "auth_refresh",
  /** Anthropic 明确拒绝历史 thinking signature 后，对请求副本清理并立即重试一次。 */
  ReasoningSignatureRepair: "reasoning_signature_repair",
} as const;

export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

export const ModelFailureReason = {
  ...ModelRetryReason,
  AuthFailed: "auth_failed",
  Cancelled: "cancelled",
  ContextExceeded: "context_exceeded",
  InvalidRequest: "invalid_request",
  ProviderNotConfigured: "provider_not_configured",
  ProxyError: "proxy_error",
  TlsError: "tls_error",
  Unknown: "unknown",
} as const;

export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];
