import type {
  ZCodeAgentCreateSessionParams,
  ZCodeAgentSessionTarget,
} from "#src/zcode-agent/zcodeAgent.js";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { ProjectTaskReservationSettlement } from "#src/project-storage/contract.js";

/** 预留收口的两种权威事实：Host 已转发输入，或 CLI 已关闭该会话。 */
export type ProjectReservationSettlementOutcome = "cli-closed" | "input-forwarded";

/**
 * 创建/恢复会话的唯一目录 port。
 *
 * node.ts 把它同时注入 agent service 与 task adapter：CLI 首发之前的项目归属预占、
 * 冷恢复的执行目录都只走这一条既有通道，不新增配置通道，也不在 Host 控制端改写 cwd。
 * 预留收口（draft 预热 dispose / 项目切换）也留在同一个 owner，不新增第二个队列。
 */
export interface ProjectSessionCreationPort {
  /** CLI 首发前原子预占；返回值就是本次冻结的附加目录。 */
  prepareSessionCreation(
    target: ZCodeAgentCreateSessionParams & { sessionId: string; projectId: string | null },
  ): Promise<string[]>;
  /** 冷恢复/运行时物化只读现有执行合同，不激活 runtime。 */
  resolveSessionDirectories(target: ZCodeAgentSessionTarget): Promise<string[]>;
  /**
   * 创建预留收口：只释放本次 Host 预占且完全未认领的空行；
   * `input-forwarded` 只丢弃 receipt（行留给 CLI 事实），不删除任何任务行。
   */
  settleCreatedTaskReservation(
    target: ZCodeAgentSessionTarget & { outcome: ProjectReservationSettlementOutcome },
  ): Promise<ProjectTaskReservationSettlement>;
}

export function createProjectSessionCreationPort(options: {
  repository(): Promise<ProjectRepositoryContract>;
}): ProjectSessionCreationPort {
  return {
    async prepareSessionCreation(target) {
      const repo = await options.repository();
      return (
        await repo.reserveCreatedTask({
          task: {
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            taskId: target.sessionId,
          },
          projectId: target.projectId,
          ...(target.additionalDirectories !== undefined
            ? { additionalDirectories: target.additionalDirectories }
            : { freezeAdditionalDirectories: true as const }),
        })
      ).additionalDirectories;
    },
    async resolveSessionDirectories(target) {
      const repo = await options.repository();
      return (
        await repo.resolveSessionDirectories({
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          taskId: target.sessionId,
        })
      ).additionalDirectories;
    },
    async settleCreatedTaskReservation(target) {
      const repo = await options.repository();
      return repo.settleCreatedTaskReservation({
        task: {
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          taskId: target.sessionId,
        },
        outcome: target.outcome,
      });
    },
  };
}
