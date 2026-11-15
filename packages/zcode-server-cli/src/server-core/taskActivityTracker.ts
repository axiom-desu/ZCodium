import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { SourceServerRunningTask } from "@zcode/shared";
import type { SessionActivity } from "@zcode/shared/zcode-protocol-v4";

interface TaskActivityTracker extends IDisposable {
  readonly onDidChangeRunningTaskCount: Event<number>;
  readRunningTaskCount(): number;
  readRunningTasks(): SourceServerRunningTask[];
}

type AgentActivitySource = Pick<
  IZCodeAgentService,
  "onAgentRuntimeLifecycle" | "onDynamicSessionActivity"
>;

interface WorkspaceActivity {
  target: ZCodeAgentWorkspaceTarget;
  activeSessionIds: Set<string>;
  runtimeIdentity: string;
  activity: IDisposable;
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function createTaskActivityTracker(
  source: AgentActivitySource | undefined,
): TaskActivityTracker {
  const changed = new Emitter<number>();
  const workspaces = new Map<string, WorkspaceActivity>();
  let runningTaskCount = 0;
  let disposed = false;

  const publishCount = (): void => {
    const next = [...workspaces.values()].reduce(
      (total, workspace) => total + workspace.activeSessionIds.size,
      0,
    );
    if (next === runningTaskCount) return;
    runningTaskCount = next;
    changed.fire(next);
  };

  const removeWorkspace = (key: string, runtimeIdentity?: string): void => {
    const current = workspaces.get(key);
    if (!current || (runtimeIdentity && current.runtimeIdentity !== runtimeIdentity)) return;
    current.activity.dispose();
    workspaces.delete(key);
    publishCount();
  };

  const acceptFact = (key: string, runtimeIdentity: string, fact: SessionActivity): void => {
    const workspace = workspaces.get(key);
    if (!workspace || workspace.runtimeIdentity !== runtimeIdentity) return;
    if (fact.state === "running") {
      workspace.activeSessionIds.add(fact.sessionId);
    } else if (fact.state === "idle") {
      workspace.activeSessionIds.delete(fact.sessionId);
    } else {
      return;
    }
    publishCount();
  };

  const acceptLifecycle = (event: ZCodeAgentRuntimeLifecycleEvent): void => {
    if (disposed) return;
    const key = event.workspaceKey || workspaceKey(event);
    if (event.state === "unavailable") {
      removeWorkspace(key, event.runtimeIdentity.identity);
      return;
    }
    removeWorkspace(key);
    const activeSessionIds = new Set<string>();
    const activity = source?.onDynamicSessionActivity(event)((fact) =>
      acceptFact(key, event.runtimeIdentity.identity, fact),
    );
    if (!activity) return;
    workspaces.set(key, {
      target: {
        workspacePath: event.workspacePath,
        ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
      },
      activeSessionIds,
      runtimeIdentity: event.runtimeIdentity.identity,
      activity,
    });
  };

  const lifecycle = source?.onAgentRuntimeLifecycle?.(acceptLifecycle);
  return {
    onDidChangeRunningTaskCount: changed.event,
    readRunningTaskCount: () => runningTaskCount,
    readRunningTasks: () =>
      [...workspaces.values()].flatMap((workspace) =>
        [...workspace.activeSessionIds].map((sessionId) => ({ ...workspace.target, sessionId })),
      ),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      lifecycle?.dispose();
      for (const workspace of workspaces.values()) workspace.activity.dispose();
      workspaces.clear();
      runningTaskCount = 0;
      changed.dispose();
    },
  };
}
