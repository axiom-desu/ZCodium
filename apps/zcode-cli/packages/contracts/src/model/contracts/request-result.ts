import type { TraceContext } from "../../tracing/tracer.js";
import type { ModelApiCallObservation } from "../../model/observation.js";
import {
  JsonSchema,
  ModelRequestAdmission,
  ModelRequestSessionType,
  ModelRetryBudget,
} from "./request-contracts.js";
import type { ModelStatusSink, ModelStreamRecoveryStatus } from "./status-contracts.js";
import type {
  ModelInputMessage,
  ModelReasoningContentBlock,
  ModelToolCall,
} from "./message-contracts.js";
import type { ModelToolChoice, ModelToolContract } from "./tool-contracts.js";
import type { ModelUsage } from "./usage-contracts.js";

export interface ModelRequestSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
}

export interface ModelTextRequest extends ModelRequestSettings {
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  toolChoice?: ModelToolChoice;
  responseJsonSchema?: JsonSchema;
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /**
   * Runtime-only hook for propagating model transport status to UI/session layers.
   * This is intentionally omitted from the JSON schema below because it is not serializable.
   */
  statusSink?: ModelStatusSink;
  /**
   * Runtime-only trace context. Serialized requests should pass trace ids through metadata.
   */
  traceContext?: TraceContext;
  /** Runtime-only、强类型的模型 API 调用分类；不会进入 Provider 请求。 */
  modelCall?: ModelApiCallObservation;
  /**
   * Runtime-only 的宿主 session 粗分类。Adapter 将它写入受控归因 header；
   * 不允许调用方通过 provider 静态 headers 覆盖。
   */
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * Runtime-only 重试预算档位（见 {@link ModelRetryBudget}）。与 modelRequestSessionType 同族：
   * 不进 JSON schema、不进 provider 请求。缺省即 `default`。
   */
  modelRetryBudget?: ModelRetryBudget;
  /**
   * Runtime-only 准入端口（见 {@link ModelRequestAdmission}）：在场时 runner 每次尝试先 acquire、
   * 结束即 release。与 statusSink 同族：不进 JSON schema、不进 provider 请求。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * Runtime-only SSE idle timeout 递增序号。0/undefined 表示首请求；
   * 每重试一次在 adapter base timeout 上加 30000ms。
   */
  streamIdleTimeoutRetryNumber?: number;
  /** Runtime-only recovery attribution；只进入 status/diagnostics，不发送给 Provider。 */
  streamRecovery?: ModelStreamRecoveryStatus;
  /**
   * Runtime-only provider stream 边界开关。compact 隐藏流用它保留首个真实 provider event
   * 与 content block provenance；tool input 提交不受此开关控制，所有请求都等待 AI SDK end。
   */
  preserveProviderStreamBoundaries?: boolean;
}

export interface ModelSource {
  type: "source";
  sourceType: "url" | "document";
  id?: string;
  url?: string;
  title?: string;
  mediaType?: string;
  filename?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelToolResult {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  providerExecuted?: boolean;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelTextResult {
  text: string;
  finishReason: string;
  usage: ModelUsage;
  reasoning?: ModelReasoningContentBlock[];
  toolCalls?: ModelToolCall[];
  toolResults?: ModelToolResult[];
  sources?: ModelSource[];
  providerMetadata?: Record<string, unknown>;
}

export type ModelStreamEvent =
  | {
      type: "start";
    }
  | {
      /**
       * Compact-only replay boundary。Adapter 从 raw provider stream 提炼真实边界；
       * 无 raw provenance 的 direct tool-call 校验失败可补一个 inferred commit。
       * 事件不携带 provider 正文，也不进入 session/UI streaming。
       */
      type: "compact_stream_boundary";
      boundary: "provider_response_start" | "inferred_content_block_stop";
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_start";
      blockType: string | null;
      index: number | null;
    }
  | {
      /** Raw delta 只携带 provenance type，不携带正文。 */
      type: "compact_stream_boundary";
      boundary: "provider_content_block_delta";
      deltaType: string | null;
      index: number | null;
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_stop";
      index: number | null;
    }
  | {
      /** 每个 provider message_delta 覆盖当前 stop reason 状态，后续 null 会清掉先前值。 */
      type: "compact_stream_boundary";
      boundary: "provider_stop_reason";
      present: boolean;
    }
  | {
      type: "text_start";
      id: string;
    }
  | {
      type: "text_delta";
      id?: string;
      text: string;
    }
  | {
      type: "text_end";
      id: string;
    }
  | {
      type: "reasoning_start";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_end";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool_input_start";
      id: string;
      toolName: string;
      providerExecuted?: boolean;
    }
  | {
      type: "tool_input_delta";
      id: string;
      delta: string;
    }
  | {
      type: "tool_input_end";
      id: string;
    }
  | {
      type: "tool_call";
      toolCall: ModelToolCall;
    }
  | {
      type: "finish";
      finishReason: string;
      providerMetadata?: Record<string, unknown>;
      usage: ModelUsage;
    }
  | {
      type: "error";
      error: unknown;
    };
