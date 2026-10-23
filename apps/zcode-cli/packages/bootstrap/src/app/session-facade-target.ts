import type { GoalStatus, TurnInputIntentMetadata } from "@zcode/contracts";
import { goalStateChangeReminderText } from "./session-facade-helpers.js";
import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-types.js";

export interface SessionTargetOperations {
  readTarget: SessionFacade["readTarget"];
  setTarget: SessionFacade["setTarget"];
  updateTargetStatus: SessionFacade["updateTargetStatus"];
  clearTarget: SessionFacade["clearTarget"];
}

export function createSessionTargetOperations(
  deps: CreateSessionFacadeDeps,
): SessionTargetOperations {
  const readTargetWithInterruptedRunRecovery = async () => {
    const target = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    if (
      !deps.runtime.getActiveTurnInfo() &&
      target?.activeInputId &&
      target.activeRunStartedAtMs != null &&
      deps.sessionStore.recoverInterruptedTargetRun
    ) {
      // 上次 app/agent 退出可能留下未清空的 active_run_started_at。
      // 这里不能用当前时间结算，否则离线时间会被算进 goal 运行时长；store 会用 last_seen 收口。
      return await deps.sessionStore.recoverInterruptedTargetRun({
        sessionID: deps.sessionId,
      });
    }
    return target;
  };

  const setTargetStatus = async (
    action: "cleared" | "set" | "status_updated",
    input: {
      objective?: string;
      displayText?: string;
      status?: GoalStatus;
      tokenBudget?: number | null;
      intent?: TurnInputIntentMetadata;
    },
  ) => {
    const visibleObjective = action === "set" ? (input.objective ?? "").trim() : undefined;
    const visibleGoalQuery =
      action === "set" ? input.displayText?.trim() || visibleObjective : undefined;
    // /goal 不走普通 prompt 提交流程，但它会先把 session 持久化。
    // 必须在首次持久化前走统一用户执行边界，否则 runtime/bash_shell_selection
    // 会因为当时 selection 为空而缺失，冷恢复时退回 legacy shell fallback。
    await deps.prepareUserExecutionBoundary({
      traceContext: deps.traceContext,
    });
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      visibleObjective ?? `/goal ${input.status ?? "clear"}`,
      { traceContext: deps.traceContext },
    );
    const previousTarget = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    const target =
      action === "set"
        ? await deps.sessionStore.setTarget({
            objective: visibleObjective ?? "",
            sessionID: deps.sessionId,
            status: input.status,
            tokenBudget: input.tokenBudget,
          })
        : action === "status_updated"
          ? await deps.sessionStore.updateTargetStatus({
              sessionID: deps.sessionId,
              status: input.status ?? "active",
            })
          : null;

    if (action === "cleared") {
      const cleared = await deps.sessionStore.clearTarget({
        sessionID: deps.sessionId,
      });
      if (cleared) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: goalStateChangeReminderText("cleared"),
          traceContext: deps.traceContext,
        });
      }
      // TUI 和协议客户端可能在重连或恢复后仍缓存旧 goal。
      // 即使 session store 已经是空，也要把显式 clear 投影成 target:null，
      // 让客户端不能只因为“No goal to clear.”这条文本而继续保留旧面板。
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
      return cleared;
    }
    if (target) {
      if (visibleObjective !== undefined) {
        // /goal 同时是控制命令和用户 query。旧路径只把解析后的 objective
        // 落库，且 live 事件里没有这条输入；因此首轮实时列表为空，冷恢复后也丢失
        // `/goal` / `/target` / `replace` 原文。target 继续存 canonical objective，
        // 可见消息单独保留协议层传入的原始 display text。
        await deps.runtime.recordExternalUserPrompt(visibleGoalQuery ?? visibleObjective, {
          goalSummaryTargetID: target.targetID,
          intent: input.intent,
          traceContext: deps.traceContext,
        });
      }
      const reminderAction =
        input.status === "paused" && previousTarget?.status !== "paused"
          ? "paused"
          : input.status === "active" && previousTarget?.status === "paused"
            ? "resumed"
            : undefined;
      const reminderText = goalStateChangeReminderText(reminderAction);
      if (reminderText) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: reminderText,
          traceContext: deps.traceContext,
        });
      }
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
    }
    return target;
  };
  return {
    clearTarget: async () => (await setTargetStatus("cleared", {})) as boolean,
    readTarget: readTargetWithInterruptedRunRecovery,
    setTarget: async (input) =>
      (await setTargetStatus("set", input)) as Awaited<ReturnType<SessionFacade["setTarget"]>>,
    updateTargetStatus: async (status) =>
      (await setTargetStatus("status_updated", { status })) as Awaited<
        ReturnType<SessionFacade["updateTargetStatus"]>
      >,
  };
}
