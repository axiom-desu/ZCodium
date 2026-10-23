import type { SessionGoal, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 本轮 target run 的活动心跳。
 *
 * 只有存在 active target 且 session store 支持 heartbeatTargetRun 时才启动；
 * 心跳本身包在 residency blocking work 里，避免进程在等待期间被判定空闲退出。
 */
export function startTargetRunHeartbeat(
  runtime: AgentRuntimeInternal,
  input: {
    inputID: string;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  },
  intervalMs: number,
): ReturnType<typeof setInterval> | undefined {
  const { inputID, startedTarget, traceContext } = input;
  if (!startedTarget || !runtime.sessionStore?.heartbeatTargetRun) return undefined;
  const heartbeat = setInterval(() => {
    void runtime.trackResidencyBlockingWork(
      runtime.heartbeatTargetTurnAccounting({
        inputID,
        seenAtMs: Date.now(),
        startedTarget,
        traceContext,
      }),
    );
  }, intervalMs);
  if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
  return heartbeat;
}
