import { createAppSessionControl } from "@zcode/session-control/app";
import type {
  MutationResult,
  SessionSummary,
  AppScope,
  AppOrganizationPort,
  AppSessionControlDependencies,
  AppSessionQueryPort,
  AppProjectPort,
  AppSessionRef,
  AppTrustedContext,
} from "@zcode/session-control/contracts";
import { createDeadlines } from "./deadlines.js";
import { forbidden, invalidInput } from "./errors.js";
import { observeTask } from "./observation.js";
import { createExecutionPort } from "./execution.js";
import type {
  AppControlBinding,
  AppControlCallerConnection,
  AppControlClientBinding,
  AppControlService,
} from "./contract.js";
import type { AppControlLiveStatus, AppControlServiceDependencies } from "./ports.js";

const workspaceKey = (value: { workspacePath: string; workspaceIdentity?: string }) =>
  value.workspaceIdentity?.trim() || value.workspacePath;

/** runtime 活动态投影到 App session 摘要的既有三态；attention 仍是在执行。 */
function summaryStatusForLive(
  live: AppControlLiveStatus,
  persisted: string | undefined,
): "running" | "idle" | "unknown" {
  if (live === "running" || live === "needs_attention") return "running";
  if (live === "idle") return "idle";
  return persisted === "running" ? "running" : persisted === "completed" ? "idle" : "unknown";
}

interface BoundCaller {
  connection: AppControlCallerConnection;
  uiTarget?: string;
}

/** 上下文 → 连接事实。用 WeakMap 而不是给契约加隐藏字段：调用方拿不到第二个可伪造入口。 */
const bindings = new WeakMap<object, BoundCaller>();

export function getAppControlBinding(context: object): BoundCaller {
  const binding = bindings.get(context);
  if (!binding) throw new Error("App control context is not bound to a live connection");
  return binding;
}

function mutation(requestId: string, reason?: string): MutationResult {
  return { status: "applied", requestId, ...(reason ? { reason } : {}) };
}

export function createAppControlService(deps: AppControlServiceDependencies): AppControlService {
  const ref = (task: {
    taskId: string;
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    projectId: string | null;
  }): AppSessionRef => ({
    kind: "app",
    sourceServerId: task.hostId,
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    sessionId: task.taskId,
    ...(task.projectId
      ? { project: { kind: "app", projectId: task.projectId, sourceServerId: task.hostId } }
      : {}),
  });

  /** 只按本 Host 的持久事实解析目标；不跨来源搜索、不把删除的行当成存在。 */
  async function requireTask(session: AppSessionRef, includeDeleted = false) {
    if (session.kind !== "app" || session.sourceServerId !== deps.sourceServerId)
      throw forbidden("Session source does not match this Host");
    const tree = await deps.projects.readTree({ includeDeletedTasks: includeDeleted });
    const task = tree.tasks.find(
      (item) =>
        item.taskId === session.sessionId &&
        item.hostId === deps.sourceServerId &&
        item.workspacePath === session.workspacePath &&
        workspaceKey(item) === workspaceKey(session),
    );
    if (!task) throw forbidden("Product session is not in the authorized source");
    if (
      session.project &&
      (session.project.projectId !== task.projectId ||
        session.project.sourceServerId !== deps.sourceServerId)
    )
      throw forbidden("Session project does not match Host ownership");
    return task;
  }

  const forkAvailable = Boolean(
    deps.projects.reserveFork && deps.agent.readConversationRows && deps.agent.forkAssistant,
  );

  const summary = (
    task: Awaited<ReturnType<typeof requireTask>>,
  ): SessionSummary<AppSessionRef> => ({
    session: ref(task),
    title: task.title,
    status:
      task.status === "running" ? "running" : task.status === "completed" ? "idle" : "unknown",
    archived: task.archived,
    pinned: task.pinned,
    availableActions: [
      "readSession",
      "sendToSession",
      "waitSessions",
      "renameSession",
      ...(forkAvailable ? (["forkSession"] as const) : []),
      "setSessionArchived",
      "setSessionPinned",
      ...(deps.navigation ? (["openSession"] as const) : []),
    ],
    ...(task.updatedAt ? { updatedAt: new Date(task.updatedAt).toISOString() } : {}),
  });

  const discoveryScopes = async (): Promise<readonly AppScope[]> => {
    const projects = await deps.projects.readProjects();
    return [
      { kind: "app", scope: "host", sourceServerId: deps.sourceServerId },
      ...projects
        .filter((project) => project.hostId === deps.sourceServerId && !project.deleted)
        .map((project) => ({
          kind: "app" as const,
          scope: "project" as const,
          projectId: project.id,
          sourceServerId: deps.sourceServerId,
        })),
    ];
  };

  async function authorizeScope(
    caller: BoundCaller,
    scope: AppScope,
    session?: AppSessionRef,
  ): Promise<void> {
    if ((scope.sourceServerId ?? deps.sourceServerId) !== deps.sourceServerId)
      throw forbidden("App source does not match the active Host");
    if (scope.scope === "project") {
      const projects = await deps.projects.readProjects();
      if (
        !projects.some(
          (project) =>
            project.id === scope.projectId &&
            project.hostId === deps.sourceServerId &&
            !project.deleted,
        )
      )
        throw forbidden("Project is unavailable");
    }
    if (session) await requireTask(session);
    caller.connection.assertCurrent();
  }

  const sessions: AppSessionQueryPort = {
    async resolveSession(_ctx, sessionId) {
      const tree = await deps.projects.readTree();
      const task = tree.tasks.find(
        (item) => item.taskId === sessionId && item.hostId === deps.sourceServerId,
      );
      return task ? ref(task) : undefined;
    },
    async listSessions(_ctx, input, grants) {
      const tree = await deps.projects.readTree({ includeDeletedTasks: false });
      const requestedProject = input.project?.projectId;
      if (requestedProject && !grants.some((grant) => grant.scope.scope === "project"))
        throw forbidden("Project discovery scope is unavailable");
      const query = input.query?.toLocaleLowerCase();
      const archivedMode = input.archived ?? "exclude";
      const scopes = await discoveryScopes();
      const rows = tree.tasks
        .filter((task) => task.hostId === deps.sourceServerId)
        .filter((task) => (archivedMode === "only" ? task.archived : true))
        .filter((task) => (archivedMode === "exclude" ? !task.archived : true))
        .filter((task) => (requestedProject ? task.projectId === requestedProject : true))
        .filter((task) => (query ? task.title.toLocaleLowerCase().includes(query) : true))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const limit = input.limit ?? 50;
      const start = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      if (!Number.isFinite(start) || start < 0) throw invalidInput("Cursor is not usable");
      const page = rows.slice(start, start + limit);
      return {
        sessions: page.map(summary),
        ...(start + limit < rows.length ? { nextCursor: String(start + limit) } : {}),
        // 发现范围只由 Host 项目归属产生；不能把授权失败的项目当成「已搜索」。
        searchScope: { scopes: [...scopes], unavailableSources: [] },
      };
    },
    async readSession(_ctx, input) {
      const task = await requireTask(input.session);
      if (input.view === "summary") {
        // 活动执行事实只从既有 runtime 只读读取；没有 executionId 就不宣称可中断。
        const live = await deps.agent.readLiveSession({
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          sessionId: task.taskId,
        });
        const value = {
          ...summary(task),
          ...(live ? { status: summaryStatusForLive(live.status, task.status) } : {}),
          ...(live?.executionId ? { executionId: live.executionId } : {}),
        };
        if (live?.executionId && !value.availableActions.includes("interruptSession")) {
          value.availableActions = [...value.availableActions, "interruptSession"];
        }
        return { view: "summary", summary: value };
      }
      const limit = input.limit ?? 50;
      const messages = await deps.agent.readSessionMessages({
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        sessionId: task.taskId,
        ...(input.cursor ? { afterMessageId: input.cursor } : {}),
        limit,
      });
      return {
        view: "messages",
        session: ref(task),
        messages: messages.map((message) => ({
          id: message.id,
          role: (["user", "assistant", "system", "tool"] as const).includes(message.role as never)
            ? (message.role as "user" | "assistant" | "system" | "tool")
            : "system",
          text: message.text,
        })),
        ...(messages.length === limit ? { nextCursor: messages[messages.length - 1]?.id } : {}),
      };
    },
  };

  const execution = createExecutionPort({
    deps,
    requireTask,
    ref,
    assertCurrent: (ctx) => getAppControlBinding(ctx).connection.assertCurrent(),
    connectionId: (ctx) => getAppControlBinding(ctx).connection.connectionId,
  });

  const organization: AppOrganizationPort = {
    async setSessionArchived(_ctx, input) {
      const task = await requireTask(input.session);
      const params = {
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      };
      if (input.archived) await deps.tasks.archiveTask(params);
      else await deps.tasks.unarchiveTask(params);
      return mutation(input.requestId);
    },
    async setSessionPinned(_ctx, input) {
      const task = await requireTask(input.session);
      await deps.tasks.setTaskPinned({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        pinned: input.pinned,
      });
      return mutation(input.requestId);
    },
  };

  const projects: AppProjectPort = {
    async listProjects() {
      const rows = await deps.projects.readProjects();
      const scopes = await discoveryScopes();
      return {
        projects: rows
          .filter((project) => project.hostId === deps.sourceServerId && !project.deleted)
          .map((project) => ({
            project: {
              kind: "app" as const,
              projectId: project.id,
              sourceServerId: deps.sourceServerId,
            },
            title: project.name,
          })),
        searchScope: { scopes: [...scopes], unavailableSources: [] },
      };
    },
  };

  const dependencies: AppSessionControlDependencies = {
    access: {
      async authorize(ctx, request) {
        const caller = getAppControlBinding(ctx);
        await authorizeScope(caller, request.scope, request.session);
        return { scope: request.scope, fence: caller.connection.connectionId };
      },
    },
    sessions,
    execution,
    organization,
    projects,
    observations: {
      async open(ctx, operation, signal, grant) {
        const caller = getAppControlBinding(ctx);
        if (grant.fence !== caller.connection.connectionId)
          throw forbidden("Observation grant does not match the live connection");
        await requireTask(operation.session);
        return observeTask(deps.tasks, operation, signal, deps.agent);
      },
    },
    ...(deps.navigation
      ? {
          navigation: {
            async openSession(_ctx, input) {
              const caller = getAppControlBinding(_ctx);
              // 目标窗口只来自可信上下文：use case 已把 ctx.uiTarget 放进 input。
              const uiTarget = (input as { uiTarget?: string }).uiTarget;
              return deps.navigation!.openSession({
                session: input.session,
                ...(uiTarget ? { uiTarget } : {}),
                binding: {
                  ...caller.connection,
                  ...(caller.uiTarget ? { uiTarget: caller.uiTarget } : {}),
                },
              });
            },
          },
        }
      : {}),
    deadlines: createDeadlines(),
  };

  return {
    control: createAppSessionControl(dependencies),
    async bind(binding: AppControlBinding) {
      // 连接事实必须属于本 Host；host-wide 授权不是“任意来源”。
      if (binding.sourceServerId !== deps.sourceServerId)
        throw forbidden("App caller connection does not belong to this Host");
      const tree = await deps.projects.readTree();
      const caller = tree.tasks.find(
        (task) =>
          task.taskId === binding.callerSessionId &&
          task.hostId === deps.sourceServerId &&
          task.workspacePath === binding.workspacePath &&
          workspaceKey(task) === workspaceKey(binding),
      );
      if (!caller) throw forbidden("App caller is not a bound product root session");
      binding.assertCurrent();
      const context = {
        callerId: binding.callerSessionId,
        rootSession: ref(caller),
        allowedScopes: await discoveryScopes(),
        discoveryScopes: await discoveryScopes(),
        ...(binding.uiTarget ? { uiTarget: binding.uiTarget } : {}),
        ...(binding.callId ? { toolCallId: binding.callId } : {}),
        ...(binding.turnId ? { turnId: binding.turnId } : {}),
        signal: binding.signal,
      } satisfies AppTrustedContext;
      bindings.set(context, {
        connection: binding,
        ...(binding.uiTarget ? { uiTarget: binding.uiTarget } : {}),
      });
      return context;
    },
    async bindClient(binding: AppControlClientBinding) {
      if (binding.sourceServerId !== deps.sourceServerId)
        throw forbidden("App client connection does not belong to this Host");
      binding.assertCurrent();
      const context = {
        caller: "client" as const,
        callerId: `${deps.sourceServerId}:client:${binding.clientId}`,
        allowedScopes: await discoveryScopes(),
        discoveryScopes: await discoveryScopes(),
        signal: binding.signal,
      } satisfies AppTrustedContext;
      bindings.set(context, { connection: binding });
      return context;
    },
  };
}
