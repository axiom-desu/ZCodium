import type { ZCodeTaskMeta } from "@zcode/shared";
import type { SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";
import type { CliTaskFacts } from "./facts.js";

export interface TaskWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}
export interface TaskFactTarget extends TaskWorkspace {
  taskId: string;
}
export type TaskFactMutation = { type: "rename"; title: string } | { type: "delete" };

/** 存储端口只接受 CLI 事实，不能据 Host 时钟或运行态推导会话事实。 */
export interface TaskFactStore {
  applyCliFacts(facts: CliTaskFacts): Promise<ZCodeTaskMeta>;
  applyCliDeletion(target: TaskFactTarget): Promise<void>;
  markCliOrphan(target: TaskFactTarget): Promise<void>;
  listReconciliationRows(
    target: TaskWorkspace,
  ): Promise<Array<{ meta: ZCodeTaskMeta; handoffPending: number }>>;
  getTaskMeta(target: TaskFactTarget): Promise<ZCodeTaskMeta | null>;
  removeSubagentIndexRow?(target: TaskFactTarget): Promise<void>;
}
/** 只有 CLI 自己的持久 store 能回答；旧远端缺此能力时保持既有行，不推断删除。 */
export interface TaskFactSource {
  reconcile(target: TaskWorkspace, sessionIds: string[]): Promise<SessionsIndexReconcileResult>;
  execute(target: TaskFactTarget, intent: TaskFactMutation): Promise<void>;
}
