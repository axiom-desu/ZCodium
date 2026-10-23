import type { SessionEvent } from "@zcode/contracts";
import type { ConversationDelta, SessionControl } from "@zcode/shared/zcode-protocol-v4";
import type { ProjectionState } from "./product-projection-state.js";
import { controlPatch, ms } from "./product-projection-primitives.js";

/**
 * draft 只有一种离场方式：第一轮收口。phase `draft` 的定义是「纯内存、从未有过真实内容、CLI 重启即
 * 消失」；一条 controlOnly 轮一旦收口，会话已有一段持久化的可见历史，再叫 draft 就与
 * 冷恢复矛盾——store 种子会给它一个终态 phase，而活投影却停在 draft。中枢直接启动
 * 的会话只有一条 controlOnly 启动轮，活投影 phase 恒为 draft，sessions-index 摘要因此被 task-index
 * syncer 当 draft 丢弃，侧栏要等重启才出现。所以 controlOnly 收口只在**会话仍是 draft**时推进 phase
 * （成功 → completedSuccess，取消 → completedInterrupted，失败 → error）；非 draft 会话上的控制轮
 * 照旧不碰 session control（goal 的可见 query 轮不得伪造 running / 工时，见 onTurnStarted）。
 */
export function leaveDraftAfterControlOnlyTurn(
  state: Pick<ProjectionState, "snapshot">,
  phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
): ConversationDelta[] {
  if (state.snapshot.control.phase !== "draft") return [];
  return [
    {
      op: "state.updated",
      patch: controlPatch(state, {
        phase,
        sessionEnded: phase !== "error",
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
      }),
    },
  ];
}

// 工时按边界拆分：drain 切过轮的 runtimeTurn，最后一段 productTurn 的工时
// = 最后一次边界到完成，不再用整段 runtime duration（否则两段加和超真实时长）。
export function activeMsForCompletion(
  state: Pick<
    ProjectionState,
    "currentProductTurnStartedAtMs" | "currentTurnId" | "productTurnSplitOrdinalByRuntimeTurnId"
  >,
  event: SessionEvent,
  runtimeDuration?: number,
): number | undefined {
  const runtimeTurnId = String(event.turnId ?? state.currentTurnId ?? "turn-unknown");
  // 稳定 user messageId 映射并不代表发生过 queue drain 切段；只有 split ordinal
  // 存在时才按边界时间计算最后一段工时。否则 cold 合成事件的展示时间戳跨度很小，
  // 会错误覆盖 transcript 已计算好的整轮 duration。
  if (!state.productTurnSplitOrdinalByRuntimeTurnId.has(runtimeTurnId)) return runtimeDuration;
  if (state.currentProductTurnStartedAtMs === null) return runtimeDuration;
  return Math.max(0, ms(event) - state.currentProductTurnStartedAtMs);
}
