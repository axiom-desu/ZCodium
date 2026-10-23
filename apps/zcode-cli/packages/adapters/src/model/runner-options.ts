import { Output, jsonSchema } from "ai";
import type { ModelToolChoice } from "@zcode/contracts";
import type { EnvRecord } from "./model-execution.js";
import { toAiSdkMessages } from "./transform.js";
import { toolSearchHeaders } from "./tool-search.js";
import { toAiSdkTools } from "./tool-transform.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

export function createGenerateTextOptions(input: {
  env?: EnvRecord;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
}): AiSdkGenerateTextOptions {
  const providerOptions = mergeProviderOptions(
    input.resolved.providerOptions,
    input.request.providerOptions,
  );
  const requestProviderOptions = withNativeGenerateOutputFormat({
    providerOptions,
    responseJsonSchema: input.request.responseJsonSchema,
    resolved: input.resolved,
  });
  return removeUndefined({
    model: input.resolved.model,
    messages: toAiSdkMessages(input.request.messages, {
      apiFormat: resolveProviderApiFormat(providerOptions),
      providerOptions,
      providerKind: input.resolved.providerKind,
      inputFormat: input.resolved.properties?.inputFormat,
      toolSearchEnabled: input.request.toolSearchEnabled,
    }),
    tools: toAiSdkTools(input.request.tools, {
      providerKind: input.resolved.providerKind,
      modelId: input.resolved.modelId,
      requiresMfjsToolSchema: input.resolved.properties.requiresMfjsToolSchema,
      supportsNativeWebSearch: input.resolved.properties.supportsNativeWebSearch,
      toolSearchEnabled: input.request.toolSearchEnabled,
    }),
    toolChoice: toAiSdkToolChoice(input.request.toolChoice),
    temperature: input.request.temperature,
    topP: input.request.topP,
    topK: input.request.topK,
    presencePenalty: input.request.presencePenalty,
    frequencyPenalty: input.request.frequencyPenalty,
    stopSequences: input.request.stopSequences,
    seed: input.request.seed,
    output: input.request.responseJsonSchema
      ? Output.object({ schema: jsonSchema(input.request.responseJsonSchema) })
      : undefined,
    providerOptions: requestProviderOptions,
    abortSignal: input.request.abortSignal,
    // 会话/请求/trace 标识只用于本地执行，不能自动作为归因头发送给模型服务。
    // beta 大小写无关合并去重，不覆盖调用方已有的 anthropic-beta 内容。
    headers: toolSearchHeaders(input.resolved.headers, input.request.toolSearchEnabled),
    // ZCode owns system-message construction in core/context. Keep AI SDK from
    // printing its generic system-message warning to process stderr.
    allowSystemInMessages: true,
    maxRetries: 0,
  }) as AiSdkGenerateTextOptions;
}

export function createStreamTextOptions(input: {
  env?: EnvRecord;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
}): AiSdkStreamTextOptions {
  const providerOptions = mergeProviderOptions(
    input.resolved.providerOptions,
    input.request.providerOptions,
  );
  const requestProviderOptions = providerOptions;
  return removeUndefined({
    model: input.resolved.model,
    messages: toAiSdkMessages(input.request.messages, {
      apiFormat: resolveProviderApiFormat(providerOptions),
      providerOptions,
      providerKind: input.resolved.providerKind,
      inputFormat: input.resolved.properties?.inputFormat,
      toolSearchEnabled: input.request.toolSearchEnabled,
    }),
    tools: toAiSdkTools(input.request.tools, {
      providerKind: input.resolved.providerKind,
      modelId: input.resolved.modelId,
      requiresMfjsToolSchema: input.resolved.properties.requiresMfjsToolSchema,
      supportsNativeWebSearch: input.resolved.properties.supportsNativeWebSearch,
      toolSearchEnabled: input.request.toolSearchEnabled,
    }),
    toolChoice: toAiSdkToolChoice(input.request.toolChoice),
    temperature: input.request.temperature,
    topP: input.request.topP,
    topK: input.request.topK,
    presencePenalty: input.request.presencePenalty,
    frequencyPenalty: input.request.frequencyPenalty,
    stopSequences: input.request.stopSequences,
    seed: input.request.seed,
    providerOptions: requestProviderOptions,
    abortSignal: input.request.abortSignal,
    // beta 大小写无关合并去重，不覆盖调用方已有的 anthropic-beta 内容。
    headers: toolSearchHeaders(input.resolved.headers, input.request.toolSearchEnabled),
    // ZCode owns system-message construction in core/context. Keep AI SDK from
    // printing its generic system-message warning to process stderr.
    allowSystemInMessages: true,
    maxRetries: 0,
    // AI SDK 会吞掉 Anthropic message_start 等 metadata 事件；compact 需要
    // 在 adapter 内观察 raw event 才能精确结束 SSE retry，raw chunk 不会上送 Core/UI。
    includeRawChunks: input.request.preserveProviderStreamBoundaries ? true : undefined,
  }) as AiSdkStreamTextOptions;
}

function toAiSdkToolChoice(
  toolChoice?: ModelToolChoice,
): AiSdkGenerateTextOptions["toolChoice"] | undefined {
  return toolChoice as AiSdkGenerateTextOptions["toolChoice"] | undefined;
}

function mergeProviderOptions(
  base?: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...base,
    ...override,
  };
}

function withNativeGenerateOutputFormat(input: {
  providerOptions: Record<string, unknown> | undefined;
  resolved: ResolvedAiSdkModel;
  responseJsonSchema: AiSdkModelTextRequest["responseJsonSchema"];
}): Record<string, unknown> | undefined {
  if (!input.responseJsonSchema || input.resolved.providerKind !== "anthropic") {
    return input.providerOptions;
  }

  const anthropicOptions = asPlainRecord(input.providerOptions?.anthropic);
  return {
    ...input.providerOptions,
    // Lite role 的真实模型 ID 可能不在 AI SDK 的静态能力表中；
    // 显式 schema 必须继续生成目标 output_config，而不能退化成 JSON tool。
    anthropic: { ...anthropicOptions, structuredOutputMode: "outputFormat" },
  };
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function resolveProviderApiFormat(providerOptions?: Record<string, unknown>): string | undefined {
  const apiFormat = providerOptions?.apiFormat;
  return typeof apiFormat === "string" ? apiFormat : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}
