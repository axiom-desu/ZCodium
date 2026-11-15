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
export function observeTask(
  tasks: AppControlTaskPort,
  operation: OperationRef<AppSessionRef>,
  signal: AbortSignal,
  live?: AppControlAgentPort,
): OperationFeed<AppSessionRef> {
  const operationRef = { ...operation, sessionId: operation.sessionId } as AppOperationRef;
  let closed = false;
  let revision = 0;
  let status: OperationSnapshot<AppSessionRef>["status"] = "unknown";
  const read = async (): Promise<OperationSnapshot<AppSessionRef>> => {
    const meta = await tasks.getTaskMeta({
      taskId: operation.session.sessionId,
      workspacePath: operation.session.workspacePath,
      ...(operation.session.workspaceIdentity
        ? { workspaceIdentity: operation.session.workspaceIdentity }
        : {}),
    });
    status = meta
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
  const initial = {
    operation: operationRef,
    epoch: "app-control",
    revision: 0,
    status: "unknown" as const,
  };
  const updates = (async function* (): AsyncIterable<OperationUpdate<AppSessionRef>> {
    let last = await read();
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
    // initial 与 updates 必须同一水位：这里先给 0，第一条 update 是它之后的第一份事实。
    initial: status === "unknown" ? initial : initial,
    updates,
    async close() {
      closed = true;
    },
  };
}
