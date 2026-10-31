import type { ProjectTask } from "@zcode/services";
import type { CreateTaskRequest } from "@/app-shell/types.js";

/**
 * 新任务的项目归属意图（UI 侧唯一规则）。
 *
 * - 显式请求（项目行新建、跨项目工作流）在第一次 await 前冻结；后续切项目/切页不得改写。
 * - 未显式表态时按“活动任务的真实项目归属”继承；没有活动任务时沿用当前草稿意图。
 * - 远端 identity 不走本地 Host 树，返回 undefined（保持既有全局/legacy 行为）。
 */
interface ExplicitProjectIntent {
  explicit: boolean;
  projectId?: string | null;
}

export function resolveExplicitProjectIntent(
  request: CreateTaskRequest | undefined,
): ExplicitProjectIntent {
  if (typeof request === "string" || !request) return { explicit: false };
  const targetProjectId = request.targetWorkspace?.projectId;
  const hasExplicit =
    "projectId" in request || (targetProjectId !== undefined && targetProjectId !== null);
  if (!hasExplicit) return { explicit: false };
  return { explicit: true, projectId: request.projectId ?? targetProjectId ?? null };
}

/** 活动任务归属按 Host 任务身份精确匹配：同 cwd 不同远端/不同任务不得串项目。 */
export function inheritNewTaskProjectId(params: {
  targetWorkspacePath: string;
  targetWorkspaceIdentity?: string;
  activeTaskId: string | null;
  draftProjectId: string | null;
  tasks:
    | readonly Pick<ProjectTask, "taskId" | "workspacePath" | "workspaceIdentity" | "projectId">[]
    | null;
}): string | null | undefined {
  if (params.targetWorkspaceIdentity?.trim()) return undefined;
  if (!params.activeTaskId) return params.draftProjectId ?? null;
  if (!params.tasks) return undefined;
  const targetKey = params.targetWorkspacePath;
  return (
    params.tasks.find(
      (task) =>
        task.taskId === params.activeTaskId &&
        (task.workspaceIdentity?.trim() || task.workspacePath) === targetKey,
    )?.projectId ?? null
  );
}
