import type { TaskFactTarget, TaskWorkspace } from "./ports.js";

/** 冷恢复仅按 CLI 身份清理 child 派生索引，不创建运行时或改写会话正文。 */
export interface SubagentIndexRepair {
  target: TaskWorkspace;
  visibleSessionIds: ReadonlySet<string>;
  agentService: {
    listSessions(
      target: TaskWorkspace & { sessionIds: string[]; runtimePolicy: "existing-only" },
    ): Promise<Array<{ sessionId: string; sessionKind?: string; workspace: TaskWorkspace }>>;
  };
  taskIndexRepo: {
    listTaskMetas(target: TaskWorkspace): Promise<Array<{ taskId: string }>>;
    removeSubagentIndexRow(target: TaskFactTarget): Promise<unknown>;
  };
  isCurrent: () => boolean;
  onRemoved: () => void;
}
