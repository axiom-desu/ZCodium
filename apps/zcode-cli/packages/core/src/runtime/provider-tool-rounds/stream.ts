// Provider 内置工具流的轮次编排：把「遇到服务端调用收轮 / 结果事件 / 流终止收口」
// 从 model.ts 的 stream switch 里拆出来，保持 model.ts 只负责事件分派与正文累计。
import type { ModelReasoningContentBlock, ModelToolCall } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  finishProviderToolCard,
  persistProviderToolRoundContent,
  settleUnfinishedProviderToolCards,
  startProviderToolCard,
  type ProviderToolCardContext,
} from "./cards.js";
import { providerToolOutputText, type ProviderToolRound } from "./rounds.js";

interface ProviderToolStreamState {
  readonly context: ProviderToolCardContext;
  rounds: ProviderToolRound[];
  startedAtByCallId: Map<string, number>;
  roundStartedAt: number;
}

export function createProviderToolStreamState(
  context: ProviderToolCardContext,
): ProviderToolStreamState {
  return {
    context,
    rounds: [],
    startedAtByCallId: new Map(),
    roundStartedAt: Date.now(),
  };
}

/** 服务端已执行：收起当前轮并按流顺序落盘（text/reasoning 先于 tool part），卡片显示为运行中。 */
export async function captureProviderToolCall(
  runtime: AgentRuntimeInternal,
  state: ProviderToolStreamState,
  input: { reasoning: ModelReasoningContentBlock[]; text: string; toolCall: ModelToolCall },
): Promise<void> {
  const round: ProviderToolRound = {
    messageId: state.context.assistantMessageId,
    reasoning: input.reasoning,
    text: input.text,
    toolCall: input.toolCall,
  };
  state.rounds.push(round);
  await persistProviderToolRoundContent(runtime, state.context, round, state.roundStartedAt);
  state.roundStartedAt = Date.now();
  state.startedAtByCallId.set(input.toolCall.id, state.roundStartedAt);
  await startProviderToolCard(runtime, state.context, input.toolCall, state.roundStartedAt);
}

/** 结果事件：先排空已入队的流事件，再写卡片终态并持久化 tool part。 */
export async function completeProviderToolResult(
  runtime: AgentRuntimeInternal,
  state: ProviderToolStreamState,
  input: { toolCallId: string; output: unknown; isError: boolean },
  drain: () => Promise<void>,
  publish: () => void,
): Promise<void> {
  const round = state.rounds.find(
    (candidate) => candidate.toolCall.id === input.toolCallId && !candidate.result,
  );
  if (!round) return;
  const result = { output: providerToolOutputText(input.output), isError: input.isError };
  round.result = result;
  await drain();
  await finishProviderToolCard(
    runtime,
    state.context,
    { ...round, result },
    state.startedAtByCallId.get(round.toolCall.id) ?? state.roundStartedAt,
  );
  publish();
}

/** 流失败/取消或正常结束时把没有结果的轮次按中断收口；收口失败不能盖住原始错误。 */
export async function settleProviderToolStream(
  runtime: AgentRuntimeInternal,
  state: ProviderToolStreamState,
  publish: () => void,
  phase: "end" | "failure",
): Promise<void> {
  try {
    const settled = await settleUnfinishedProviderToolCards(
      runtime,
      state.context,
      state.rounds,
      state.startedAtByCallId,
    );
    if (settled) publish();
  } catch (error) {
    runtime.logger?.warn("Failed to settle provider tool cards", {
      error: error instanceof Error ? error.message : String(error),
      event: "model.provider_tool_cards.settle_failed",
      module: "core.runtime",
      phase,
      status: "failed",
    });
  }
}
