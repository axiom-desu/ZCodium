import { runWithSessionResidencyFinalization } from "../../../zcode-protocol/session-residency.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import { V4GoalCompactRejectedError } from "./goal-compact-errors.js";

// 手动 compact 在后台 turn 真正登记前，下一条 command 已可能完成 admission。
// 仅看 runtime activeTurn 会留下一个极短的重复 compact 窗口；controller WeakSet 只补齐
// operation lock 的同步边界，不复制 queue 或 lifecycle 业务状态。
const manualCompactControllers = new WeakSet<AbortController>();

export function isManualCompactInFlight(controller: AbortController | undefined): boolean {
  return controller ? manualCompactControllers.has(controller) : false;
}

/** queue promotion 与直接命令共用唯一手动 compact 启动路径。 */
export async function startManualCompact(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  inputId: string,
  foregroundPromotionLeaseId?: string,
): Promise<void> {
  if (record.restoreWarning) {
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }
  // 冷恢复后用户可能直接触发 /compact（不先经 sendText），compact 的后台模型请求
  // 同样需要模型就绪检查——钩子（见 types.ts）。
  await host.ensureModelReady?.(record);
  const abortController = new AbortController();
  // compact 的真实模型请求在后台执行，但 Stop 仍通过
  // record.activeAbortController 中断。不登记 controller，压缩中的请求会跑到自然结束。
  record.activeAbortController = abortController;
  manualCompactControllers.add(abortController);
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(host, record, {
      abortController,
      foregroundPromotionLeaseId,
      inputId,
    }),
  ).catch(() => {
    // 后台 compact 的错误经事件流（CompactStarted/终态 marker）降级上报；兜底防 unhandled rejection。
  });
}

async function runCompactTurnInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  let lifecycleStatus: "success" | "failed" | "cancelled" = "success";
  host.logger?.info?.("v4 background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt("/compact", {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch (error) {
    lifecycleStatus = params.abortController.signal.aborted ? "cancelled" : "failed";
    mutationReason =
      lifecycleStatus === "cancelled" ? "session_compact_cancelled" : "session_compact_failed";
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // queued compact 是 FIFO barrier；失败/Stop 后若继续 auto-drain，
        // 后续文本会越过用户显式维护意图。与普通 Stop 一致切为 held。
        await record.app.setQueueAutoDrain(false);
      } catch (holdError) {
        host.logger?.warn?.("v4 compact failed to hold following queue", {
          error: holdError instanceof Error ? holdError.message : String(holdError),
          inputId: params.inputId,
          sessionId: record.app.sessionId,
        });
      }
    }
    host.logger?.warn?.("v4 background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    manualCompactControllers.delete(params.abortController);
    if (record.activeAbortController === params.abortController) {
      // ready 边界（关键约束）：compact 结束后必须先释放 active lock 再广播；
      // 否则 queued prompt 或后续 /compact 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  try {
    // compact 没有 user message，不能依赖 SessionInputPromoted 解 pin；无论 lifecycle
    // 成功/失败/取消，都用 timeline command fact 阻止重启后把已执行命令再次提示重放。
    await host.recordPersistentCommandFact?.(
      record.app.sessionId,
      "timeline",
      {
        commandId: params.inputId,
        status: "accepted",
        revisionAtDecision: 0,
      },
      { lifecycleStatus },
    );
  } catch (error) {
    // compact 已执行，不能因查重旁路写失败伪装为模型执行失败。
    host.logger?.warn?.("v4 compact persistent command fact failed", {
      commandId: params.inputId,
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
  }
  // 旧协议路径在此调 afterStateMutation → 用钩子等价替代（随旧广播删除）。
  await host.afterLegacyStateMutation?.(record, mutationReason);
}
