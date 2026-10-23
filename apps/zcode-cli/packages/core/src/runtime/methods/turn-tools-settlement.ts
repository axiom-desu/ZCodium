// tool result 的持久化/模型历史/恢复锚点收尾：turn-tools 只负责编排与调度。
import type {
  MessageId,
  ToolCall,
  ToolCallId,
  ToolExecutionResult,
  TraceContext,
} from "../deps.js";
import {
  createStreamRecoveryAnchorId,
  emitStreamRecoveryAnchor,
  emitStreamingToolLedgerUpdate,
  isErrorForToolResult,
  isTurnCancellationError,
  modelContentForToolResult,
  stringifyToolResultOutput,
} from "../helpers/index.js";
import { persistToolResultMediaAttachments } from "../helpers/tool-result-media-persistence.js";
import type { StreamedToolExecutionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { projectToolNameForNonEmptyBoundary } from "./tool-part-persistence.js";
import { completedToolPartMetadata, mcpToolPartMetadata } from "./tool-part-metadata.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordToolUsageFromResult } from "./turn-tool-usage.js";
import { createRuntimeToolResultEntry } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import { enqueueFollowUpUserInputFromToolResult } from "./turn-tools-follow-up-input.js";
import type { ToolPartHandle } from "./turn-tools-declaration.js";

export async function settleToolResults(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    results: ToolExecutionResult[];
    streamedResultsById: ReadonlyMap<ToolCallId, StreamedToolExecutionResult>;
    toolCallById: ReadonlyMap<string, ToolCall>;
    toolParts: ReadonlyMap<string, ToolPartHandle>;
  },
): Promise<unknown> {
  const { results, streamedResultsById, toolCallById, toolParts } = options;
  let deferredCheckpointCancellation: unknown;
  for (const result of results) {
    await recordToolUsageFromResult(this, result, options.modelTraceContext);
    const content = stringifyToolResultOutput(result);
    const isError = isErrorForToolResult(result);
    const projectedResultToolName = projectToolNameForNonEmptyBoundary(result.toolName);
    const persisted = toolParts.get(result.toolCallId);
    if (persisted) {
      const mediaPersistence = result.success
        ? await persistToolResultMediaAttachments({
            artifactStore: this.artifactStore,
            assistantMessageId: options.assistantMessageId,
            content: modelContentForToolResult(result),
            sessionId: this.sessionId,
            sessionStore: this.sessionStore,
            signal: state.turnAbortSignal,
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            traceContext: options.modelTraceContext,
            turnId: state.turnId,
          })
        : undefined;
      await this.persistPart(
        {
          id: persisted.partID,
          sessionID: this.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: result.toolCallId,
          declarationIndex: persisted.declarationIndex,
          tool: projectedResultToolName.toolName,
          metadata: {
            ...projectedResultToolName.metadata,
            ...(toolCallById.get(result.toolCallId as ToolCallId)?.modelCallWrapper
              ? {
                  modelCallWrapper: toolCallById.get(result.toolCallId as ToolCallId)
                    ?.modelCallWrapper,
                }
              : {}),
          },
          state: result.success
            ? {
                status: "completed",
                input: persisted.input,
                output: content,
                title: projectedResultToolName.toolName,
                metadata: {
                  ...completedToolPartMetadata(result),
                  ...(mediaPersistence
                    ? { modelContentLayout: mediaPersistence.modelContentLayout }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
                ...(mediaPersistence ? { attachments: mediaPersistence.attachments } : {}),
              }
            : {
                status: "error",
                input: persisted.input,
                error: result.error?.message ?? content,
                // state.error 面向 UI / 日志，可能比模型实际收到的
                // modelContent 更笼统；仅附加保存 string 内容供冷恢复精确重放。
                metadata: {
                  ...mcpToolPartMetadata(
                    this.registry.getMetadata(result.toolName)?.mcpPresentation,
                  ),
                  ...(typeof result.modelContent === "string" || Array.isArray(result.modelContent)
                    ? { modelContent: result.modelContent }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
              },
        },
        options.modelTraceContext,
      );
    }
    this.logger?.debug("addToolResult", {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      success: result.success,
      contentLength: content.length,
    });
    commitTurnRequestEntries(this, state.turnRequestState, [
      createRuntimeToolResultEntry(
        result.toolCallId,
        result.toolName,
        modelContentForToolResult(result),
        isError,
        toolCallById.get(result.toolCallId as ToolCallId)?.modelCallWrapper,
      ),
    ]);
    try {
      // checkpoint 是 tool result 闭合后的附加操作。Stop 若在这里
      // 触发，必须先继续提交所有 sibling tool results，不能提前进入 reminder flush。
      await this.emitFileMutationCheckpoint({
        abortSignal: state.turnAbortSignal,
        events: state.events,
        messageId: state.userMessageId,
        result,
        toolMessageId: options.assistantMessageId,
        traceContext: options.modelTraceContext,
      });
    } catch (error) {
      if (!isTurnCancellationError(error, state.turnAbortSignal)) throw error;
      deferredCheckpointCancellation ??= error;
      continue;
    }
    const toolCall = toolCallById.get(result.toolCallId as ToolCallId);
    if (toolCall) {
      const resultPartId = persisted?.partID;
      const recoveryAnchorId = createStreamRecoveryAnchorId(
        options.assistantMessageId,
        result.toolCallId as ToolCallId,
      );
      await emitStreamRecoveryAnchor(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCallId: result.toolCallId as ToolCallId,
        toolName: projectedResultToolName.toolName,
        success: result.success,
        resultPartId,
        committedAt: result.completedAt,
      });
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_result_committed",
        executionTiming: streamedResultsById.has(result.toolCallId as ToolCallId)
          ? "during_stream"
          : "end_of_stream",
        input: persisted?.input,
        startedAt: result.startedAt,
        committedAt: result.completedAt,
        resultPartId,
        recoveryAnchorId,
      });
    }
    await enqueueFollowUpUserInputFromToolResult.call(
      this,
      state,
      result,
      options.modelTraceContext,
    );
  }
  return deferredCheckpointCancellation;
}
