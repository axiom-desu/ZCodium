/**
 * 每个 ask 的 WebSearch 预算端口。
 *
 * 成因：一个子代理在长 turn 里退化后，77 分钟发了约 2000 次 WebSearch（查询退化成 void / halt /
 * schema 字段名），直到用户手动停止；loop 按设计不限工具次数，stall 时钟只看请求是否成功，
 * 没有任何东西能让它停下。预算把一次 ask 的搜索量封顶，超额调用不再发内部模型请求。
 *
 * 与升级预算同族：计数在 driver 的会话状态里（唯一数据源），startAsk 归零，nudge / repair 轮
 * 共用；端口按会话 closure 绑定，模型改不了路由。
 */

import type { PersonaSpec } from "@zcode/dynamic-workflow";
import type {
  SessionId,
  WebSearchBudgetCharge,
  WorkflowWebSearchBudgetPort,
} from "@zcode/contracts";
import type { SessionState } from "./workflow-driver-types.js";

/**
 * 每个 ask 的 WebSearch 默认上限：persona 没写 `budget.webSearch` 时生效。
 * 引擎侧（persona 类型与编译期 9013 校验）属另一片；本片按结构读取，引擎补上后无需改动。
 */
export const DEFAULT_WEB_SEARCH_BUDGET_PER_ASK = 128;

/** persona 可写的 WebSearch 上限的最大值。没有「不限」：退化的模型会一直搜下去。 */
export const MAX_WEB_SEARCH_BUDGET_PER_ASK = 1024;

/** 预算耗尽时回给模型的错误文案。要求在结果里说明，是让主代理与用户得知预算被打满的唯一通道。 */
export function webSearchBudgetExhaustedMessage(limit: number): string {
  return (
    `Search budget exhausted: at most ${limit} WebSearch calls per task. ` +
    "Do not call WebSearch again in this task. Finish from the information you already have, " +
    "and state in your result that your search was cut short by the search budget."
  );
}

/** persona 的 `budget.webSearch` 结构视图：引擎尚未在本仓类型里声明该字段。 */
interface PersonaBudgetView {
  budget?: { webSearch?: unknown };
}

/** 本子代理每个 ask 的上限：persona 写了合法整数就用它，否则默认值。 */
export function webSearchLimitOf(persona: PersonaSpec): number {
  const raw = (persona as PersonaSpec & PersonaBudgetView).budget?.webSearch;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return DEFAULT_WEB_SEARCH_BUDGET_PER_ASK;
  if (raw < 0 || raw > MAX_WEB_SEARCH_BUDGET_PER_ASK) return DEFAULT_WEB_SEARCH_BUDGET_PER_ASK;
  return raw;
}

/**
 * 造会话级预算端口。`sessions` 是 driver 的会话表：会话状态在端口之后才建，所以按 id 晚查。
 * 没有在飞 ask 时（不应发生）不扣也不拦——没有 ask 就没有可归属的预算。
 */
export function makeWebSearchBudgetPort(
  sessions: ReadonlyMap<string, SessionState>,
  sessionId: SessionId,
): WorkflowWebSearchBudgetPort {
  return {
    charge: (): WebSearchBudgetCharge => {
      const state = sessions.get(sessionId);
      if (state === undefined || state.currentInstance === undefined) return { kind: "charged" };
      if (state.webSearchesUsed >= state.webSearchLimit) {
        return {
          kind: "exhausted",
          limit: state.webSearchLimit,
          message: webSearchBudgetExhaustedMessage(state.webSearchLimit),
        };
      }
      state.webSearchesUsed++;
      return { kind: "charged" };
    },
  };
}
