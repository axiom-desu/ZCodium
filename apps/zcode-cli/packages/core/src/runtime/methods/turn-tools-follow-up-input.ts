import { traceContextToLogContext } from "../deps.js";
import type { ToolExecutionResult, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/**
 * 工具结果携带的 follow-up 用户输入：走既有 steerTurn('guide') admission，
 * 不新开队列或绕过 activeTurn/lease 判定。拒绝只记结构化日志，不静默吞掉。
 */
export async function enqueueFollowUpUserInputFromToolResult(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: ToolExecutionResult,
  traceContext: TraceContext,
): Promise<void> {
  const followUp = result.followUpUserInput;
  if (!followUp) return;

  const input = followUp.input.trim();
  if (!input) return;

  const steerResult = await this.steerTurn({
    delivery: "guide",
    expectedTurnId: state.activeTurn?.turnId,
    input,
    source: followUp.reasonSource,
    traceContext,
  });

  if (steerResult.kind === "queued") {
    this.logger?.debug("Queued follow-up user input from tool result", {
      ...traceContextToLogContext(traceContext),
      event: "tool.follow_up_user_input.queued",
      module: "core.runtime",
      pendingInputId: steerResult.pendingInputId,
      reasonSource: followUp.reasonSource,
      status: "waiting",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
    });
    return;
  }

  // ExitPlanMode 审批反馈必须升级成真实 user message；
  // 如果这里被拒绝，说明 active turn 状态异常或输入超过 steer 限制，不能静默吞掉。
  this.logger?.warn("Failed to queue follow-up user input from tool result", {
    ...traceContextToLogContext(traceContext),
    activeTurnId: steerResult.activeTurnId,
    event: "tool.follow_up_user_input.rejected",
    module: "core.runtime",
    reason: steerResult.reason,
    reasonSource: followUp.reasonSource,
    status: "failed",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
  });
}
