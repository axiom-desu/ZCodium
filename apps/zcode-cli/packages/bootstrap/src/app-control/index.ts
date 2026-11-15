import {
  appControlCancelMethod,
  appControlCancelResultSchema,
  appControlProtocol,
  SessionControlError,
  type AppControlAction,
  type AppSessionControl,
  type AppSessionTrustedContext,
} from "@zcode/session-control/contracts";
import type { SessionTaskType } from "@zcode/contracts";
import type { AppSessionControlBinding } from "@zcode/core";
import type { ZCodeProtocolAgentServerContext } from "../zcode-protocol/server-types.js";

const CONTROL_REQUEST_TIMEOUT_MS = 60_000;
const CONTROL_WAIT_TIMEOUT_MS = 310_000;

interface AppSessionControlTransportOptions {
  requestClient: ZCodeProtocolAgentServerContext["requestClient"];
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sourceServerId?: string;
}

/**
 * CLI 侧的 App control 绑定：只做传输，不在 CLI 重跑 App 用例、不创建 runtime。
 *
 * 十二个意图与 Host 的 `appControl/*` 一一对应；身份由工具执行上下文注入，
 * 模型既看不到也改不了 `callerSessionId`/`callId`。取消只释放本次观察。
 */
export function createAppSessionControlTransport(
  options: AppSessionControlTransportOptions,
): AppSessionControlBinding {
  const rootSession = {
    kind: "app" as const,
    workspacePath: options.workspacePath,
    sessionId: options.sessionId,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.sourceServerId ? { sourceServerId: options.sourceServerId } : {}),
  };
  async function call<A extends AppControlAction>(
    action: A,
    trusted: AppSessionTrustedContext,
    input: unknown,
  ) {
    if (
      trusted.rootSession.sessionId !== options.sessionId ||
      trusted.rootSession.workspacePath !== options.workspacePath ||
      !trusted.toolCallId
    )
      throw new SessionControlError(
        "forbidden",
        "App session control requires the bound root session and tool call.",
      );
    trusted.signal?.throwIfAborted();
    const endpoint = appControlProtocol[action];
    const params = endpoint.params.parse({
      callerSessionId: options.sessionId,
      callId: trusted.toolCallId,
      ...(trusted.turnId ? { turnId: trusted.turnId } : {}),
      input,
    });
    const trace = trusted.traceId ? { traceId: trusted.traceId } : undefined;
    const cancel = () => {
      void options
        .requestClient(
          appControlCancelMethod as never,
          { callerSessionId: options.sessionId, callId: trusted.toolCallId },
          appControlCancelResultSchema,
          { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS, trace },
        )
        .catch(() => undefined);
    };
    trusted.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = endpoint.result.parse(
        // 共享协议表尚未登记 appControl/*（Host 侧按原始方法名分派），这里只透传已封闭的方法名。
        await options.requestClient<unknown>(endpoint.method as never, params, endpoint.result, {
          signal: trusted.signal,
          trace,
          timeoutMs:
            action === "waitSessions" ? CONTROL_WAIT_TIMEOUT_MS : CONTROL_REQUEST_TIMEOUT_MS,
        }),
      );
      if (!result.ok) throw new SessionControlError(result.error.code, result.error.message);
      return result.result;
    } finally {
      trusted.signal?.removeEventListener("abort", cancel);
    }
  }
  const control = {
    listProjects: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("listProjects", ctx, input),
    listSessions: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("listSessions", ctx, input),
    readSession: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("readSession", ctx, input),
    createSession: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("createSession", ctx, input),
    forkSession: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("forkSession", ctx, input),
    sendToSession: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("sendToSession", ctx, input),
    waitSessions: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("waitSessions", ctx, input),
    interruptSession: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("interruptSession", ctx, input),
    renameSession: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("renameSession", ctx, input),
    openSession: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("openSession", ctx, input),
    setSessionArchived: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("setSessionArchived", ctx, input),
    setSessionPinned: (ctx: AppSessionTrustedContext, input: unknown) =>
      call("setSessionPinned", ctx, input),
  } as unknown as AppSessionControl;
  return {
    kind: "app",
    control,
    context: () =>
      ({
        callerId: options.sessionId,
        rootSession,
        allowedScopes: [{ ...rootSession, scope: "workspace" as const }],
      }) as AppSessionTrustedContext,
  };
}

/**
 * 可信启动能力 → App 绑定。`appControlEnabled` 只来自 Host 的能力回包；Durable
 * 会话种类与父会话沿用上游规则，避免把 fork/子会话或未授权根升级为 App 控制者。
 */
export function resolveAppControlEnabledBinding(options: {
  appControlEnabled: boolean;
  taskType?: SessionTaskType;
  parentSessionId?: string;
  requestClient: ZCodeProtocolAgentServerContext["requestClient"];
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): AppSessionControlBinding | undefined {
  if (!options.appControlEnabled) return undefined;
  const mainRoot =
    options.taskType === "fork" ||
    (!options.parentSessionId &&
      (options.taskType === "interactive" || options.taskType === "workflow_parent"));
  if (!mainRoot) return undefined;
  return createAppSessionControlTransport({
    requestClient: options.requestClient,
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
  });
}
