import { createPartId } from "../deps.js";
import type { MessageId, ModelToolCall, ToolCall, ToolCallId, TraceContext } from "../deps.js";
import { emitStreamingToolLedgerUpdate, toRecordInput } from "../helpers/index.js";
import type { Model } from "../deps.js";
import type { StreamedToolExecutionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitSyntheticStreamedToolError } from "./streaming-tool-synthetic-result.js";
import { persistPendingToolPart } from "./tool-part-persistence.js";
import { mcpToolPartMetadata } from "./tool-part-metadata.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/** 单个 tool call 的持久化句柄；owner 仍是 turn-tools 的本次 model step。 */
export interface ToolPartHandle {
  partID: ReturnType<typeof createPartId>;
  declarationIndex: number;
  input: Record<string, unknown>;
  startedAt: number;
}

interface PersistDeclaredToolPartsInput {
  coreToolCalls: ToolCall[];
  model: Model;
  streamedResultsById: Map<string, StreamedToolExecutionResult>;
  toolParts: Map<string, ToolPartHandle>;
}

interface ToolDeclarationStepOptions {
  assistantMessageId: MessageId;
  modelTraceContext: TraceContext;
  toolCalls: ModelToolCall[];
}

/**
 * model step 的 tool declaration 持久化步骤：先登记每个 tool part 与 streaming ledger，
 * 让 Stop/恢复看到已声明的调用。执行、调度与结果提交仍在 `turn-tools.ts`。
 */
export async function persistDeclaredToolParts(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ToolDeclarationStepOptions,
  input: PersistDeclaredToolPartsInput,
): Promise<void> {
  const { coreToolCalls, model, streamedResultsById, toolParts } = input;
  for (const [declarationIndex, toolCall] of coreToolCalls.entries()) {
    const streamed = streamedResultsById.get(toolCall.id as ToolCallId);
    if (streamed) {
      toolParts.set(toolCall.id, {
        declarationIndex,
        partID: streamed.partID,
        input: streamed.input,
        startedAt: streamed.result.startedAt.getTime(),
      });
      if (streamed.ledgerRecorded === false) {
        await persistPendingToolPart(this, {
          assistantMessageId: options.assistantMessageId,
          declarationIndex,
          input: streamed.input,
          partID: streamed.partID,
          toolCall,
          traceContext: options.modelTraceContext,
          model,
          metadata: mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
        });
        await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
          assistantMessageId: options.assistantMessageId,
          toolCall,
          status: "tool_call_closed",
          executionTiming: "during_stream",
          input: streamed.input,
        });
        await emitSyntheticStreamedToolError(
          this,
          state.events,
          options.modelTraceContext,
          streamed.result,
        );
      }
      continue;
    }
    const partID = createPartId();
    const normalizedInput = toRecordInput(toolCall.input);
    toolParts.set(toolCall.id, {
      declarationIndex,
      partID,
      input: normalizedInput,
      startedAt: Date.now(),
    });
    await persistPendingToolPart(this, {
      assistantMessageId: options.assistantMessageId,
      declarationIndex,
      input: normalizedInput,
      partID,
      toolCall,
      traceContext: options.modelTraceContext,
      model,
      metadata: mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
    });
    await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
      assistantMessageId: options.assistantMessageId,
      toolCall,
      status: "tool_call_closed",
      input: normalizedInput,
    });
  }
}
