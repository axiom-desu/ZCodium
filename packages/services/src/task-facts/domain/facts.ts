import type { ZCodeTaskMeta } from "@zcode/shared";

/**
 * 已通过协议 schema 校验的 CLI 会话事实。
 * 该类型只承载 CLI owner 真实给出的字段：Host 时钟、UI 状态和“缺失/分页”不得填充。
 */
export interface CliSessionFacts {
  sessionId: string;
  title: string;
  titleSource?: "default" | "generated" | "custom" | "first_input";
  createdAt: number;
  updatedAt: number;
  lastOutcome?: "completed" | "interrupted" | "error";
  parentSessionId?: string;
  /** 仅 reconcile 结果携带；sessions-index 帧的删除事件单独走 removed。 */
  deleted?: boolean;
  /** reconcile 结果显式不存在（区别于 snapshot 缺席）。 */
  exists?: boolean;
}

export interface CliTaskFacts {
  meta: ZCodeTaskMeta;
  titleSource?: string;
  lastOutcome?: "completed" | "interrupted" | "error";
  deleted?: boolean;
}
