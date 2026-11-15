import type {
  AppOperationRef,
  AppSessionRef,
  OperationFeed,
  OperationRef,
  OperationSnapshot,
  OperationUpdate,
} from "@zcode/session-control/contracts";
import type { AppControlAgentPort, AppControlTaskPort } from "./ports.js";

/**
 * 观察通过读 owner 状态派生，不是第二份执行队列：每次读 task meta，
 * 状态变化才发快照；任务消失/状态未知即显式结束，让 wait 得到确定结论。
 * 运行中额外读既有 runtime 的活动执行 id，作为调用方中断的凭据。
 */
export async function observeTask(
  tasks: AppControlTaskPort,
  operation: OperationRef<AppSessionRef>,
  signal: AbortSignal,
  live?: AppControlAgentPort,
): Promise<OperationFeed<AppSessionRef>> {
  const operationRef = { ...operation, sessionId: operation.sessionId } as AppOperationRef;
  let closed = false;
  let revision = 0;
  const read = async (): Promise<OperationSnapshot<AppSessionRef>> => {
    const meta = await tasks.getTaskMeta({
      taskId: operation.session.sessionId,
      workspacePath: operation.session.workspacePath,
      ...(operation.session.workspaceIdentity
        ? { workspaceIdentity: operation.session.workspaceIdentity }
        : {}),
    });
    const status: OperationSnapshot<AppSessionRef>["status"] = meta
      ? meta.status === "running"
        ? "running"
        : meta.status === "error"
          ? "failed"
          : "completed"
      : "unknown";
    const executionId =
      status === "running"
        ? (
            await live?.readLiveSession({
              workspacePath: operation.session.workspacePath,
              ...(operation.session.workspaceIdentity
                ? { workspaceIdentity: operation.session.workspaceIdentity }
                : {}),
              sessionId: operation.session.sessionId,
            })
          )?.executionId
        : undefined;
    revision += 1;
    return {
      operation: operationRef,
      epoch: "app-control",
      revision,
      status,
      ...(executionId ? { executionId } : {}),
    };
  };
  // 初始水位必须是 owner 的真实快照：合成的 revision 0/unknown 会让 waitSessions 在
  // 第一个 baseline 上就判定 unknown 并立即返回（扩展会话能力因此永远等不到终态）。
  const initial = await read();
  const updates = (async function* (): AsyncIterable<OperationUpdate<AppSessionRef>> {
    let last = initial;
    while (!closed && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      if (closed || signal.aborted) return;
      const next = await read();
      if (next.status === last.status) continue;
      last = next;
      yield { type: "snapshot", snapshot: next };
      if (next.status !== "running") return;
    }
  })();
  return {
    initial,
    updates,
    async close() {
      closed = true;
    },
  };
}
