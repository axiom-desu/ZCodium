import { SessionControlError } from "@zcode/session-control/contracts";
import type {
  AppSessionExecutionPort,
  AppSessionRef,
  AppTrustedContext,
  MutationResult,
} from "@zcode/session-control/contracts";
import { appControlCommandId } from "./identity.js";
import { invalidInput, unavailable } from "./errors.js";
import type {
  AppControlConversationPage,
  AppControlServiceDependencies,
  AppControlTaskRow,
} from "./ports.js";

/** 执行类端口：真实入口仍是 task/agent owner；App control 只做准入与结果映射。 */
export function createExecutionPort(options: {
  deps: AppControlServiceDependencies;
  requireTask: (session: AppSessionRef) => Promise<AppControlTaskRow>;
  ref: (task: {
    taskId: string;
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    projectId: string | null;
  }) => AppSessionRef;
  /** 可信连接代际；命令发送前后都由同一 binding 复验，Host 换代后旧调用不得落命令。 */
  assertCurrent: (ctx: AppTrustedContext) => void;
  connectionId: (ctx: AppTrustedContext) => string;
}): AppSessionExecutionPort {
  const { deps, requireTask, ref, assertCurrent, connectionId } = options;
  const mutation = (requestId: string, reason?: string): MutationResult => ({
    status: "applied",
    requestId,
    ...(reason ? { reason } : {}),
  });
  const execution: AppSessionExecutionPort = {
    async createSession(ctx, input, grant) {
      // 项目引用来自 ListProjects 的精确回放；项目目录仍由项目 owner 冻结。
      if (grant.scope.scope !== "project" || input.project.projectId !== grant.scope.projectId)
        throw invalidInput("Create target must be the authorized project");
      const directories = await deps.projects.prepareSession({
        projectId: input.project.projectId,
        hostId: deps.sourceServerId,
      });
      const created = await deps.tasks.createTask({
        workspacePath: directories.workspacePath,
        ...(directories.workspaceIdentity
          ? { workspaceIdentity: directories.workspaceIdentity }
          : {}),
        projectId: directories.projectId,
        additionalDirectories: directories.additionalDirectories,
        deferPersistenceUntilFirstPrompt: true,
        v4Create: true,
      });
      const session = ref({
        taskId: created.taskId,
        hostId: deps.sourceServerId,
        workspacePath: created.workspacePath,
        workspaceIdentity: created.workspaceIdentity,
        projectId: input.project.projectId,
      });
      const commandId = appControlCommandId(ctx.callerId, input.requestId);
      try {
        await deps.tasks.sendPrompt({
          taskId: created.taskId,
          traceId: commandId as never,
          content: input.prompt,
          clientMode: "desktop-continuous",
        });
      } catch (error) {
        // 会话已建立但首条输入未接纳：分别报告，不伪造成「创建失败」。
        return {
          requestId: input.requestId,
          creation: "created",
          firstInput: "unknown",
          delivery: "unknown",
          session,
          reason: error instanceof Error ? "first_input_unsettled" : "first_input_unsettled",
        };
      }
      return {
        requestId: input.requestId,
        creation: "created",
        firstInput: "accepted",
        delivery: "start_now",
        session,
        operation: {
          session,
          sessionId: session.sessionId,
          commandId,
        },
      };
    },
    async forkSession(ctx, input) {
      const task = await requireTask(input.session);
      const readRows = deps.agent.readConversationRows;
      const sendFork = deps.agent.forkAssistant;
      const reserveFork = deps.projects.reserveFork;
      // 只有真实能力都在场才给 fork；缺一个就明确 unavailable，不伪装成「所有 Agent 都不支持」。
      if (!readRows || !sendFork || !reserveFork)
        throw unavailable("Forking an App session is not available on this Host");
      // 父会话仍在执行时不分叉：边界与子会话归属都必须来自稳定快照。
      const meta = await deps.tasks.getTaskMeta({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
      if (meta?.status === "running")
        return { status: "rejected", requestId: input.requestId, reason: "parent_busy" };
      assertCurrent(ctx);
      const boundary = await resolveForkBoundary({
        readRows,
        connectionId: connectionId(ctx),
        session: task,
        atMessage: input.atMessage,
        signal: ctx.signal,
      });
      if (!boundary.ok)
        return { status: "rejected", requestId: input.requestId, reason: boundary.reason };
      // 分页读是异步的：发送命令前再核对一次连接代际（Host 换代/撤销）。
      assertCurrent(ctx);
      const commandId = appControlCommandId(ctx.callerId, input.requestId);
      let ack: Awaited<ReturnType<typeof sendFork>>;
      try {
        ack = await sendFork({
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          sessionId: task.taskId,
          target: boundary.target,
          baseRevision: boundary.baseRevision,
          baseLogEpoch: boundary.baseLogEpoch,
          commandId,
          clientId: ctx.callerId,
          clientMode: "desktop-continuous",
        });
      } catch {
        // 命令可能已被 CLI 受理，但回执在传输中丢失：按未知收口，不写预留、不猜成功。
        return {
          status: "unknown",
          requestId: input.requestId,
          reason: "fork_result_unavailable",
        };
      }
      if (ack.status === "unsupported")
        // 旧 Agent 明确不认识 v4 forkAssistant；这不是普通 rejected，也不能假装 created。
        throw unavailable("This session runtime does not support stable App forks");
      if (ack.status === "rejected")
        return {
          status: "rejected",
          requestId: input.requestId,
          reason: ack.reason ?? "fork_rejected",
        };
      if (ack.status === "unknown")
        // 传输结果不明：命令可能已被受理，保留调用方 receipt，不写预留也不删除任何目录。
        return {
          status: "unknown",
          requestId: input.requestId,
          reason: ack.reason ?? "fork_result_unavailable",
        };
      // CLI 不应把父会话当作子会话；出现即无法证明子身份，按未知收口。
      if (ack.sessionId === task.taskId)
        return {
          status: "unknown",
          requestId: input.requestId,
          reason: "fork_child_identity_conflict",
        };
      const session = { ...ref(task), sessionId: ack.sessionId };
      try {
        await reserveFork({
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          taskId: ack.sessionId,
          projectId: task.projectId,
          forkedFromTaskId: task.taskId,
        });
        return { status: "created", requestId: input.requestId, session };
      } catch {
        // 子会话已由 CLI 创建：预留失败只能报告未知，保留 receipt/目录，不能回滚成 rejected。
        return {
          status: "unknown",
          requestId: input.requestId,
          session,
          reason: "fork_ownership_unavailable",
        };
      }
    },
    async sendToSession(ctx, input) {
      const task = await requireTask(input.session);
      // 幂等键必须按调用方命名空间：create/fork 已用 appControlCommandId(callerId, requestId),
      // 这里若只用 requestId，两个插件对同一会话的相同 requestId 会撞到同一条命令/接收回执。
      const commandId = appControlCommandId(ctx.callerId, input.requestId);
      await deps.tasks.sendPrompt({
        taskId: task.taskId,
        traceId: commandId as never,
        content: input.prompt,
        clientMode: "desktop-continuous",
      });
      const session = ref(task);
      return {
        requestId: input.requestId,
        session,
        operation: { session, sessionId: session.sessionId, commandId },
        admission: "accepted",
        // 目标忙碌时由既有 CommandInbox 排队；App 层不预判，按未知交付上报。
        delivery: "unknown",
      };
    },
    async interruptSession(_ctx, input) {
      const task = await requireTask(input.session);
      const meta = await deps.tasks.getTaskMeta({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
      // 旧执行已结束：不要仅凭「现在有 running」去停一个调用方没看到的后续 run。
      if (!meta || meta.status !== "running")
        return { status: "rejected", requestId: input.requestId, reason: "not_running" };
      // 停止凭据必须交给原 runtime owner 做原子比较；Host 不在这里缓存 run 真相，
      // 也不在 mismatch 后自动重试新 execution。
      const stopped = await deps.tasks.stopGeneration({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        expectedExecutionId: input.expectedExecutionId,
      });
      if (!stopped.applied)
        return {
          status: "rejected",
          requestId: input.requestId,
          reason: stopped.reason ?? "stale",
        };
      return mutation(input.requestId);
    },
    async renameSession(_ctx, input) {
      const task = await requireTask(input.session);
      await deps.tasks.renameTask({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        title: input.title,
      });
      return mutation(input.requestId);
    },
  };
  return execution;
}

type ForkBoundary =
  | {
      ok: true;
      target: { rowId: number; entityId: string };
      baseRevision: number;
      baseLogEpoch: string;
    }
  | { ok: false; reason: string };

/**
 * messageId → V4 row target 的显式映射。
 *
 * ReadSession(view=messages) 返回 transcript messageId；V4 投影只暴露
 * entityId/assistantResponseId。只接受与 atMessage 精确相等、且 owner 标记
 * canFork 的 assistant 轮尾段；不取“最后一条”，也不把 messageId 当 rowId。
 * 所有页必须来自同一 revision/logEpoch 快照，否则边界已过期，命令不发送。
 */
async function resolveForkBoundary(options: {
  readRows: NonNullable<AppControlServiceDependencies["agent"]["readConversationRows"]>;
  connectionId: string;
  session: AppControlTaskRow;
  atMessage: string;
  signal: AbortSignal | undefined;
}): Promise<ForkBoundary> {
  const { readRows, connectionId, session, atMessage, signal } = options;
  const pageLimit = 200;
  let beforeRowId: number | undefined;
  let snapshot: Pick<AppControlConversationPage, "atRevision" | "atLogEpoch"> | undefined;
  // 行数有界；上限只防 owner 返回不前进的光标，不作为业务超时。
  for (let pageIndex = 0; pageIndex < 500; pageIndex += 1) {
    if (signal?.aborted) throw new SessionControlError("cancelled", "Fork lookup cancelled");
    const page = await readRows({
      workspacePath: session.workspacePath,
      ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
      sessionId: session.taskId,
      ...(beforeRowId !== undefined ? { beforeRowId } : {}),
      limit: pageLimit,
      connectionId,
      clientMode: "desktop-continuous",
    });
    if (!snapshot) snapshot = { atRevision: page.atRevision, atLogEpoch: page.atLogEpoch };
    else if (page.atRevision !== snapshot.atRevision || page.atLogEpoch !== snapshot.atLogEpoch)
      return { ok: false, reason: "fork_target_stale" };
    const matches = page.rows.filter(
      (item) =>
        item.kind === "assistantText" &&
        (item.assistantResponseId === atMessage || item.entityId === atMessage),
    );
    if (matches.length > 0) {
      // 同一 response 可有多段正文；只有 owner 标记 canFork 的轮尾段是稳定边界。
      const row = matches.findLast((item) => item.canFork === true);
      if (!row?.entityId) return { ok: false, reason: "fork_target_not_stable" };
      return {
        ok: true,
        target: { rowId: row.rowId, entityId: row.entityId },
        baseRevision: snapshot.atRevision,
        baseLogEpoch: snapshot.atLogEpoch,
      };
    }
    if (!page.hasMore) return { ok: false, reason: "fork_target_not_found" };
    const nextBeforeRowId = page.rows[0]?.rowId;
    if (
      nextBeforeRowId === undefined ||
      (beforeRowId !== undefined && nextBeforeRowId >= beforeRowId)
    )
      return { ok: false, reason: "fork_target_stale" };
    beforeRowId = nextBeforeRowId;
  }
  return { ok: false, reason: "fork_target_stale" };
}
