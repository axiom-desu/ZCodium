import { createMessageId } from "../deps.js";
import type { MessageId } from "../deps.js";
import { throwIfTurnAborted } from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { prepareModelStepRequest } from "./turn-model-step-request.js";
import type { ModelStepOptions } from "./turn-model-step-request.js";
import { handleModelStepFailure } from "./turn-model-step-failure.js";
import { applyModelStepResult } from "./turn-model-step-result.js";
import { estimateCurrentModelInputTokens } from "./compact.js";
import {
  resolveModelStepMaxOutputTokens,
  resolveNormalRequestMaxOutputTokens,
} from "./model-token-limits.js";

export type ModelStepResult = "continue" | "output_continuation" | "break";

export async function runModelBackedTurnStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ModelStepOptions,
): Promise<ModelStepResult> {
  const assistantMessageId = createMessageId();
  return runModelBackedTurnStepImpl.call(this, state, options, assistantMessageId);
}

async function runModelBackedTurnStepImpl(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ModelStepOptions,
  assistantMessageId: MessageId,
): Promise<ModelStepResult> {
  const prepared = await prepareModelStepRequest.call(this, state, options, assistantMessageId);
  const { modelTraceContext, streamRecoveryRequest, streamState, streamingToolCoordinator } =
    prepared;
  const model = state.model;

  let result: RuntimeModelTextResult;
  try {
    const baselineMaxOutputTokens = resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: prepared.executionMaxOutputTokens,
    });
    result = await this.runModelTextRequest({
      abortSignal: state.turnAbortSignal,
      assistantMessageId: prepared.assistantMessageId,
      events: state.events,
      maxOutputTokens: resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens,
        contextWindow: prepared.executionContextWindow,
        estimatedCurrentUsage: estimateCurrentModelInputTokens(
          options.messages,
          options.sourceEntries,
        ),
        modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      }),
      latestRealUserMessageIndex: options.latestRealUserMessageIndex,
      messages: options.messages,
      sourceEntries: options.sourceEntries,
      model,
      onStreamSnapshot: (snapshot) => {
        streamState.latestSnapshot = snapshot;
      },
      onModelNetworkStatus: prepared.recordModelNetworkStatus,
      onStreamReasoningDelta: (text) => streamingToolCoordinator.recordReasoningDelta(text),
      onStreamTextDelta: (text) => streamingToolCoordinator.recordTextDelta(text),
      onStreamToolCall: (toolCall) => streamingToolCoordinator.accept(toolCall),
      streamRecovery: streamRecoveryRequest,
      tools: options.tools,
      toolSearch: options.toolSearch,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(state.turnAbortSignal);
  } catch (error) {
    return await handleModelStepFailure.call(this, state, options, prepared, error);
  }
  return await applyModelStepResult.call(this, state, options, prepared, result);
}
