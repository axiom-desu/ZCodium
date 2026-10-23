import { SESSION_ENTRY_MODEL_SELECTION, traceContextToLogContext } from "@zcode/contracts";
import type { Logger } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/provider";
import type { CreateSessionFacadeDeps, SessionResourceCloseInput } from "./session-facade-types.js";

const DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS = 6_000;

export async function closeSessionResources(input: SessionResourceCloseInput): Promise<void> {
  try {
    // 第一拍先关闭 runtime admission；后续 execution cancel 只能收口状态，不能再唤醒模型。
    input.beginShutdown();
  } catch (error) {
    input.logger.warn("Failed to begin runtime shutdown", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.shutdown_admission.failed",
    });
  }

  const timeoutMs = Math.max(
    1,
    Math.trunc(input.timeoutMs ?? DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS),
  );
  const resources: Array<[name: string, close: (() => Promise<void> | void) | undefined]> = [
    ["browser_session", input.closeBrowserSession],
    ["execution", input.closeExecution],
    ["mcp", input.closeMcp],
    ["node_repl_browser_broker", input.closeNodeReplBrowserBroker],
  ];

  // 旧关闭链串行 await；Browser close 永不 settle 时，Execution/MCP 永远不会执行。
  // 各 owner 并行、独立带 deadline，任何一个失败都不能跳过其它资源。
  await Promise.all(
    resources.flatMap(([name, close]) =>
      close ? [closeSessionResourceWithinDeadline(name, close, timeoutMs, input.logger)] : [],
    ),
  );

  try {
    input.closeSessionStore?.();
  } catch (error) {
    input.logger.warn("Failed to close session store", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.resource_close.failed",
      resource: "session_store",
    });
  }
}

async function closeSessionResourceWithinDeadline(
  name: string,
  close: () => Promise<void> | void,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closePromise = Promise.resolve().then(close);
  const outcome = await Promise.race([
    closePromise.then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ type: "timed_out" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome.type === "completed") return;
  if (outcome.type === "timed_out") {
    logger.warn("Session resource close timed out", {
      event: "session.resource_close.timed_out",
      resource: name,
      timeoutMs,
    });
    return;
  }
  logger.warn("Session resource close failed", {
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    event: "session.resource_close.failed",
    resource: name,
  });
}

export async function persistSessionModelSelection(deps: CreateSessionFacadeDeps): Promise<void> {
  if (!deps.sessionStore.saveSessionEntry) return;
  const selection = deps.runtime.getSessionModelSelection();
  if (!selection) return;
  const timestamp = Date.now();
  try {
    await deps.sessionStore.saveSessionEntry({
      id: `${deps.sessionId}:runtime-model-selection`,
      sessionID: deps.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      // 模型与思考档位是 session-local 原子选型；切换后立即落同一稳定 entry，
      // 不必等下一条消息，也不会在冷恢复时读取 workspace/draft 的全局最新选择。
      // 同时配置补写不代表用户新活动，不能触发 session.time_updated 变成“刚刚”。
      data: {
        modelId: selection.modelId,
        providerId: selection.providerId,
        ...(selection.options ? { options: selection.options } : {}),
      },
    });
  } catch (error) {
    // 选型已经在当前 runtime 生效；持久化失败不能反向伪装成切换失败，但必须留生产日志。
    deps.logger.warn("Session model selection persistence failed", {
      ...traceContextToLogContext(deps.traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "bootstrap",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}

/** 仅供仍以 provider/model 字符串工作的内部 App facade；不是 ModelSelection 序列化。 */
export function formatLegacyRuntimeModelValue(selection: ModelSelection | undefined): string {
  return selection ? `${selection.providerId}/${selection.modelId}` : "";
}

type GoalStateChangeReminderAction = "paused" | "resumed" | "cleared";

export function goalStateChangeReminderText(action: GoalStateChangeReminderAction): string;
export function goalStateChangeReminderText(action: undefined): undefined;
export function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined;
export function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined {
  switch (action) {
    case "paused":
      return "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    case "resumed":
      return "The session goal is active again and will be pursued.";
    case "cleared":
      return "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.";
    default:
      return undefined;
  }
}
