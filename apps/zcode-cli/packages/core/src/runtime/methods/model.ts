import { beginLocalTurnPreparation } from "@zcode/contracts";
import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type { ModelReasoningContentBlock, ModelToolCall, ModelUsage, ToolCallId } from "../deps.js";
import {
  normalizeStreamError,
  normalizeModelToolCallsForRuntime,
} from "../helpers/index.js";
import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { modelRequestTokenLimitLogContext } from "./model-token-limits.js";
import { createStreamEnqueuers } from "./model-stream-enqueue.js";
import { createToolInputDeltaBuffer } from "./model-tool-input-delta.js";
import { projectModelRequestInput } from "./model-request-projection.js";
import { getOrCreateReasoningBlock } from "./reasoning-stream.js";
import { resolveModelRequestSessionTypeFromTaskType } from "./model-request-session-type.js";
import { reportModelStreamFinishDiagnostics } from "./model-stream-diagnostics.js";
import {
  captureProviderToolCall,
  completeProviderToolResult,
  createProviderToolStreamState,
  settleProviderToolStream,
} from "../provider-tool-rounds/stream.js";
import { readSessionFeatures } from "../session-features/contract.js";
import {
  recordRequestContextComposition,
  recordRequestContextCompositionUsage,
} from "../context-composition/state.js";

export async function runModelTextRequest(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Promise<RuntimeModelTextResult> {
  const finishAssembly = beginLocalTurnPreparation(options.traceContext, "request_assembly");
  const model = options.model;
  const executionModelSelection = {
    providerId: model.providerId,
    modelId: model.modelId,
  };
  const projectedOptions = await projectModelRequestInput.call(this, options, model);
  // 正常请求传递模型级 effective 预算，Compact 传递 min(effective, 20K) 的 summary
  // 任务预算；adapter 只做 provider 兼容映射，不再施加独立 global cap。
  const modelInvocationContext = {
    metadata: traceContextToLogContext(projectedOptions.traceContext),
    modelRequestSessionType: resolveModelRequestSessionTypeFromTaskType(this.config.taskType),
    // 会话能力标签是 runtime 字段，不是 config：workflow 子 actor 展开父 config 时不会继承。
    modelRequestSessionFeatures: readSessionFeatures(this),
    // 重试预算与准入端口不在这里设：它们是 runtime 层字段，由 createRuntimeModel 绑在句柄上，turn step 与工具内部的模型调用同一来源。
    modelCall: {
      // 普通 Agent Step 以前只靠 metadata.querySource 在 Adapter 中反推
      // operation/actor；元数据一旦改名或缺失，就会误记为 tool_internal_model_call。
      // Runtime 已经拥有原始执行语义，应在请求边界直接声明，旧映射只作兼容兜底。
      actorKind:
        this.config.taskType === "subagent_child"
          ? ("subagent" as const)
          : this.config.taskType === "workflow_child" ||
              this.config.taskType === "nested_workflow_child"
            ? ("workflow_child" as const)
            : ("main" as const),
      operation: "agent_step" as const,
      operationId: projectedOptions.traceContext.spanId,
      ...(projectedOptions.streamRecovery
        ? {
            callCause: "recovery" as const,
            attributes: {
              streamRecoveryNumber: projectedOptions.streamRecovery.retryNumber,
            },
          }
        : {}),
    },
    statusSink: this.createModelStatusSink(projectedOptions.traceContext, projectedOptions.events, {
      ...(projectedOptions.onModelNetworkStatus
        ? { onStatus: projectedOptions.onModelNetworkStatus }
        : {}),
      ...(projectedOptions.streamRecovery
        ? { streamRecovery: projectedOptions.streamRecovery }
        : {}),
    }),
    traceContext: projectedOptions.traceContext,
    // SSE 已经输出后由 core recovery 重发新请求；这些请求在 adapter 看起来都是 attempt=1，
    // 必须把 recovery 次数带过去，才能把 idle timeout 从首请求窗口逐次递增。
    streamIdleTimeoutRetryNumber: projectedOptions.streamRecovery?.retryNumber,
    streamRecovery: projectedOptions.streamRecovery,
  };
  const modelRequest = {
    messages: projectedOptions.messages,
    tools: projectedOptions.tools,
    // 只有 Native 才发送协议标记；Local 开启不发送 beta/defer_loading/tool_reference。
    toolSearchEnabled: projectedOptions.toolSearch?.mode === "native",
    abortSignal: projectedOptions.abortSignal,
    ...(projectedOptions.maxOutputTokens !== undefined
      ? { options: { maxOutputTokens: projectedOptions.maxOutputTokens } }
      : {}),
  };

  this.logger?.debug(
    "Model request token limits",
    modelRequestTokenLimitLogContext({
      contextWindow: model.properties.contextWindow,
      maxOutputTokens: projectedOptions.maxOutputTokens,
      modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      traceContext: projectedOptions.traceContext,
    }),
  );
  const contextUsageSnapshot = this.buildContextUsageSnapshot(projectedOptions);
  const contextUsageBreakdown = this.buildContextUsageBreakdownFromSnapshot(contextUsageSnapshot);
  this.logContextUsageSnapshot(projectedOptions, contextUsageSnapshot);
  // context 组成的「请求」相位与圆环来自同一次分解（子 spec §2.1）。
  recordRequestContextComposition(this, {
    model,
    breakdown: contextUsageSnapshot.composition,
  });

  if (!this.shouldStreamModelText()) {
    const result = await runWithModelInvocationContext(modelInvocationContext, () =>
      model.generateText(modelRequest),
    );
    const normalizedToolCalls = normalizeModelToolCallsForRuntime(result.toolCalls, {
      logger: this.logger,
      model: executionModelSelection,
      source: "generateText",
      traceContext: projectedOptions.traceContext,
    });
    recordRequestContextCompositionUsage(this, contextUsageSnapshot.composition, result.usage);
    return {
      ...result,
      ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
      toolCalls: normalizedToolCalls,
    };
  }

  let text = "";
  let finishReason = "unknown";
  let usage: ModelUsage = {};
  let providerMetadata: Record<string, unknown> | undefined;
  let reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();
  const toolCalls: ModelToolCall[] = [];
  const toolCallIds = new Set<string>();
  // 服务端内置工具把一次响应切成多轮：text/reasoning 只属于当前轮，遇到 provider 调用就收起。
  const providerToolStream = createProviderToolStreamState({
    assistantMessageId: options.assistantMessageId,
    events: options.events,
    traceContext: options.traceContext,
  });
  const publishStreamSnapshot = () => options.onStreamSnapshot?.({ reasoning, text });
  const {
    drain: drainStreamingEvents,
    enqueue: enqueueStreamingEvent,
    enqueueAndDrain: enqueueStreamingEventAndDrain,
  } = createStreamEnqueuers({
    events: options.events,
    runtime: this,
    traceContext: options.traceContext,
  });
  const toolInputDeltaBuffer = createToolInputDeltaBuffer({
    assistantMessageId: options.assistantMessageId,
    enqueue: enqueueStreamingEvent,
    logger: this.logger,
    traceContext: options.traceContext,
  });

  const modelStream = runWithModelInvocationContext(modelInvocationContext, () =>
    model.streamText(modelRequest),
  );
  finishAssembly();
  try {
    for await (const event of modelStream) {
      switch (event.type) {
        case "start": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "start",
          });
          break;
        }

        case "text_start": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_start",
          });
          break;
        }

        case "text_delta": {
          text += event.text;
          options.onStreamTextDelta?.(event.text);
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "text_delta",
          });
          break;
        }

        case "text_end": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_end",
          });
          break;
        }

        case "reasoning_start": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
          });
          if (event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_start",
          });
          break;
        }

        case "reasoning_delta": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
          });
          block.text += event.text;
          options.onStreamReasoningDelta?.(event.text);
          if (event.providerMetadata) block.providerOptions = event.providerMetadata;
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "reasoning_delta",
          });
          break;
        }

        case "reasoning_end": {
          const block = reasoningById.get(event.id);
          if (block && event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          reasoningById.delete(event.id);
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_end",
          });
          break;
        }

        case "tool_input_start": {
          const toolCallId = event.id as ToolCallId;
          toolInputDeltaBuffer.discard(toolCallId);
          this.logger?.debug("Model streaming tool input started", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_start",
            module: "core.runtime",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_start",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          break;
        }

        case "tool_input_delta": {
          await toolInputDeltaBuffer.append(event.id as ToolCallId, event.delta);
          break;
        }

        case "tool_input_end": {
          await toolInputDeltaBuffer.flush(event.id as ToolCallId);
          this.logger?.debug("Model streaming tool input ended", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_end",
            module: "core.runtime",
            toolCallId: event.id,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_end",
            toolCallId: event.id as ToolCallId,
          });
          break;
        }

        case "tool_call": {
          const [toolCall] =
            normalizeModelToolCallsForRuntime([event.toolCall], {
              logger: this.logger,
              model: executionModelSelection,
              source: "streamText",
              traceContext: options.traceContext,
            }) ?? [];
          if (!toolCall) {
            break;
          }
          await toolInputDeltaBuffer.flush(toolCall.id as ToolCallId);
          if (toolCallIds.has(toolCall.id)) {
            // 防御原因：协议兼容或自定义 adapter 路径可能重复投递同 id 的 final tool_call；
            // runtime 按 id 去重，避免同一次响应内重复执行。
            break;
          }
          toolCallIds.add(toolCall.id);
          toolCalls.push(toolCall);
          this.logger?.debug("Model streaming tool call completed", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_call",
            inputKeys:
              typeof toolCall.input === "object" &&
              toolCall.input !== null &&
              !Array.isArray(toolCall.input)
                ? Object.keys(toolCall.input as Record<string, unknown>)
                : [],
            module: "core.runtime",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            input: toolCall.input,
            kind: "tool_call",
            toolCallId: toolCall.id as ToolCallId,
            toolName: toolCall.name,
          });
          options.onStreamToolCall?.(toolCall);
          if (toolCall.providerExecuted) {
            await captureProviderToolCall(this, providerToolStream, { reasoning, text, toolCall });
            text = "";
            reasoning = [];
            reasoningById.clear();
            publishStreamSnapshot();
          }
          break;
        }

        case "provider_tool_result": {
          await completeProviderToolResult(
            this,
            providerToolStream,
            event,
            drainStreamingEvents,
            publishStreamSnapshot,
          );
          break;
        }

        case "finish": {
          finishReason = event.finishReason;
          usage = event.usage;
          providerMetadata = event.providerMetadata;
          await toolInputDeltaBuffer.flushAll();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "finish",
          });
          break;
        }

        case "error": {
          await toolInputDeltaBuffer.flushAll();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "error",
          });
          // AI SDK 的 error chunk 常是 ProviderBusinessError 的 plain object（如 3007），
          // 若只做 JSON.stringify 会丢失 providerCode，UI 只能看到泛化的 stream 失败文案。
          throw normalizeStreamError(event.error);
        }
      }
    }
  } catch (error) {
    await drainStreamingEvents();
    await settleProviderToolStream(this, providerToolStream, publishStreamSnapshot, "failure");
    throw error;
  }
  await drainStreamingEvents();
  await settleProviderToolStream(this, providerToolStream, publishStreamSnapshot, "end");

  reportModelStreamFinishDiagnostics(this, {
    finishReason,
    model: executionModelSelection,
    providerMetadata,
    textLength: text.length,
    toolCallCount: toolCalls.length,
    traceContext: options.traceContext,
    usage,
  });

  recordRequestContextCompositionUsage(this, contextUsageSnapshot.composition, usage);
  return {
    ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
    finishReason,
    providerMetadata,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    ...(providerToolStream.rounds.length > 0
      ? { providerToolRounds: providerToolStream.rounds }
      : {}),
    usage,
  };
}
