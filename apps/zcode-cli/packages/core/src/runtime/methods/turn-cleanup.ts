import type { TraceContext, TurnId } from "../deps.js";
import { createTurnAbortScope } from "../helpers/index.js";
import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function cleanupTurnExecution(
  this: AgentRuntimeInternal,
  params: {
    activeTurn: ActiveTurnSteeringState | undefined;
    targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
    turnAbortScope: ReturnType<typeof createTurnAbortScope>;
    turnId: TurnId;
    turnTraceContext: TraceContext;
  },
): Promise<void> {
  if (params.targetRunHeartbeat) {
    clearInterval(params.targetRunHeartbeat);
  }
  this.releaseTurnStart(params.turnId);
  clearBrowserTurnState(this.sessionId, params.turnId);
  this.finishActiveTurn(params.activeTurn);
  params.turnAbortScope.dispose();
  try {
    await this.browserControlPort?.turnEnded?.({
      sessionId: this.sessionId,
      turnId: String(params.turnId),
      traceContext: params.turnTraceContext,
    });
  } catch (error) {
    // 生命周期清理失败不能覆盖已经完成/失败的主 turn；backend 会在 session close 再兜底释放。
    this.logger?.warn("Browser turn cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "browser.turn_cleanup.failed",
      turnId: String(params.turnId),
    });
  }
}
