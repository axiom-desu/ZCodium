import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import type { TaskFactMutation, TaskFactTarget, TaskWorkspace } from "./ports.js";

export interface TaskFactChange {
  target: TaskFactTarget;
  meta?: ZCodeTaskMeta;
  reason: ZCodeWorkspaceTaskListChanged["reason"];
}
export interface TaskFactsContract {
  /** sessions-index 摘要/真实 CLI snapshot 的字段；不广播。 */
  ingest(
    target: TaskWorkspace,
    facts: import("./facts.js").CliSessionFacts,
  ): Promise<ZCodeTaskMeta>;
  /** CLI 明确删除事件。 */
  removed(target: TaskFactTarget): Promise<void>;
  /** 只读 CLI 持久事实；用于创建/恢复后立即进入项目投影。 */
  refresh(target: TaskFactTarget): Promise<ZCodeTaskMeta | null>;
  mutate(target: TaskFactTarget, intent: TaskFactMutation): Promise<ZCodeTaskMeta | null>;
  reconcile(
    target: TaskWorkspace,
    presentSessionIds: ReadonlySet<string>,
    stillCurrent: () => boolean,
  ): Promise<void>;
}
