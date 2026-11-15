import {
  EXTENSION_CAPABILITIES,
  type CapabilityInput,
  type CapabilityOutput,
  type CapabilityId,
} from "../capabilities.js";
import type { ExtensionSlotContribution } from "../contributions.js";
import type { ExtensionCapabilityResponse, ExtensionErrorCode } from "../protocol.js";

/**
 * 扩展 SDK：扩展进程内使用的最小客户端。
 *
 * 所有能力都经 loopback 走到窗口 Local Host 的能力网关；SDK 不持有授权、代际或业务状态，
 * 也不直接访问文件系统/网络以外的宿主服务。身份只经 Authorization 头传递；请求体不携带 token。
 */
export class ExtensionHostError extends Error {
  constructor(
    readonly code: ExtensionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionHostError";
  }
}

export interface ExtensionHostClientOptions {
  endpoint: string;
  token: string;
  generation: number;
  workspaceIdentity: string;
  pluginId: string;
  /** 供测试注入；默认使用全局 fetch。 */
  fetch?: typeof fetch;
}

export interface ExtensionHostClient {
  call<K extends CapabilityId>(
    capabilityId: K,
    input: CapabilityInput<K>,
  ): Promise<CapabilityOutput<K>>;
  contribute(slots: ExtensionSlotContribution[]): Promise<number>;
  /** 订阅宿主投影修订号；返回取消函数。只保留一个轮询，避免每个插件各建计时器。 */
  onContextChanged(listener: (revision: number) => void): () => void;
  dispose(): void;
}

/**
 * 能力调用：输入按能力表校验（扩展侧先做一次，宿主再做一次），错误统一抛 ExtensionHostError，
 * 调用方据此决定降级而不是猜测错误字符串。
 */
export function createExtensionHostClient(
  options: ExtensionHostClientOptions,
): ExtensionHostClient {
  const fetchImpl = options.fetch ?? fetch;
  const controllers = new Set<AbortController>();
  const listeners = new Set<(revision: number) => void>();
  let disposed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastRevision = -1;

  const headers = { "content-type": "application/json", authorization: `Bearer ${options.token}` };

  async function request<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
    if (disposed) throw new ExtensionHostError("host-unavailable", "Extension host is stopped.");
    let response: Response;
    try {
      response = await fetchImpl(`${options.endpoint}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted)
        throw new ExtensionHostError("canceled", "Extension request was canceled.");
      throw new ExtensionHostError(
        "host-unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    const payload = (await response.json().catch(() => null)) as
      | { ok: true; result?: unknown; revision?: number }
      | { ok: false; code: ExtensionErrorCode; message: string }
      | null;
    if (!payload) throw new ExtensionHostError("backend-error", "Extension host returned no body.");
    if (!payload.ok) throw new ExtensionHostError(payload.code, payload.message);
    if (payload.revision !== undefined) return payload.revision as T;
    return payload.result as T;
  }

  return {
    async call(capabilityId, input) {
      const def = EXTENSION_CAPABILITIES[capabilityId];
      if (!def) throw new ExtensionHostError("unknown-capability", capabilityId);
      const controller = new AbortController();
      controllers.add(controller);
      try {
        return await request<CapabilityOutput<typeof capabilityId>>(
          "/capability",
          {
            v: 1,
            generation: options.generation,
            workspaceIdentity: options.workspaceIdentity,
            pluginId: options.pluginId,
            capabilityId,
            input: input ?? null,
            requestId: randomRequestId(),
          },
          controller.signal,
        );
      } finally {
        controllers.delete(controller);
      }
    },
    async contribute(slots) {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        return await request<number>(
          "/contribute",
          {
            v: 1,
            generation: options.generation,
            workspaceIdentity: options.workspaceIdentity,
            pluginId: options.pluginId,
            slots,
          },
          controller.signal,
        );
      } finally {
        controllers.delete(controller);
      }
    },
    onContextChanged(listener) {
      listeners.add(listener);
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          void this.call("context.get", undefined as never)
            .then((context) => {
              if (disposed || context.revision === lastRevision) return;
              lastRevision = context.revision;
              for (const current of listeners) current(context.revision);
            })
            .catch(() => {
              // 订阅失败由网关的撤销/停止负责；这里不额外重试，避免扩展自建轮询策略。
            });
        }, 2_000);
        pollTimer.unref?.();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      listeners.clear();
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}

function randomRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Math.random().toString(36).slice(2)}`;
}

/** 写动作在 ctx 上 requestId 可选；线上帧仍必填，由这里补 UUID（幂等键）。 */
type WithOptionalRequestId<T> = T extends { requestId: string }
  ? Omit<T, "requestId"> & { requestId?: string }
  : T;

function withRequestId<T extends { requestId?: string }>(input: T): T & { requestId: string } {
  return { ...input, requestId: input.requestId ?? randomRequestId() };
}

/**
 * 会话 facade：上游十二个既有 App 意图，入参/返回直接复用 session-control 的 canonical schema
 * （`CapabilityInput`/`CapabilityOutput` 由能力表推导），不新增 DTO。
 * 读需要 sessions.read，写需要 sessions.write（write 包含 read）；未声明/未授予由网关注绝。
 * 身份、代际与取消全部由网关注入：ctx 不暴露插件 id、token 或 service 引用。
 */
export interface ExtensionSessionsContext {
  listProjects(
    input: CapabilityInput<"sessions.listProjects">,
  ): Promise<CapabilityOutput<"sessions.listProjects">>;
  listSessions(
    input: CapabilityInput<"sessions.listSessions">,
  ): Promise<CapabilityOutput<"sessions.listSessions">>;
  readSession(
    input: CapabilityInput<"sessions.readSession">,
  ): Promise<CapabilityOutput<"sessions.readSession">>;
  waitSessions(
    input: CapabilityInput<"sessions.waitSessions">,
  ): Promise<CapabilityOutput<"sessions.waitSessions">>;
  createSession(
    input: WithOptionalRequestId<CapabilityInput<"sessions.createSession">>,
  ): Promise<CapabilityOutput<"sessions.createSession">>;
  forkSession(
    input: WithOptionalRequestId<CapabilityInput<"sessions.forkSession">>,
  ): Promise<CapabilityOutput<"sessions.forkSession">>;
  sendToSession(
    input: WithOptionalRequestId<CapabilityInput<"sessions.sendToSession">>,
  ): Promise<CapabilityOutput<"sessions.sendToSession">>;
  interruptSession(
    input: WithOptionalRequestId<CapabilityInput<"sessions.interruptSession">>,
  ): Promise<CapabilityOutput<"sessions.interruptSession">>;
  renameSession(
    input: WithOptionalRequestId<CapabilityInput<"sessions.renameSession">>,
  ): Promise<CapabilityOutput<"sessions.renameSession">>;
  openSession(
    input: CapabilityInput<"sessions.openSession">,
  ): Promise<CapabilityOutput<"sessions.openSession">>;
  setSessionArchived(
    input: WithOptionalRequestId<CapabilityInput<"sessions.setSessionArchived">>,
  ): Promise<CapabilityOutput<"sessions.setSessionArchived">>;
  setSessionPinned(
    input: WithOptionalRequestId<CapabilityInput<"sessions.setSessionPinned">>,
  ): Promise<CapabilityOutput<"sessions.setSessionPinned">>;
}

/** 插件作者入口：`activate` 收到的 ctx 只有能力与槽位，没有宿主对象引用。 */
export interface ExtensionContext {
  pluginId: string;
  settings: { get(): Promise<CapabilityOutput<"settings.get">> };
  projects: { list(): Promise<CapabilityOutput<"projects.list">> };
  context: {
    get(): Promise<CapabilityOutput<"context.get">>;
    onDidChange(listener: (revision: number) => void): () => void;
  };
  sessions: ExtensionSessionsContext;
  slots: { contribute(slots: ExtensionSlotContribution[]): Promise<number> };
}

export type ExtensionActivate = (
  context: ExtensionContext,
) => void | (() => void) | Promise<void | (() => void)>;

export function defineExtension(activate: ExtensionActivate): { activate: ExtensionActivate } {
  return { activate };
}

export function createExtensionContext(
  client: ExtensionHostClient,
  pluginId: string,
): ExtensionContext {
  return {
    pluginId,
    settings: { get: () => client.call("settings.get", undefined as never) },
    projects: { list: () => client.call("projects.list", undefined as never) },
    context: {
      get: () => client.call("context.get", undefined as never),
      onDidChange: (listener) => client.onContextChanged(listener),
    },
    sessions: {
      listProjects: (input) => client.call("sessions.listProjects", input),
      listSessions: (input) => client.call("sessions.listSessions", input),
      readSession: (input) => client.call("sessions.readSession", input),
      waitSessions: (input) => client.call("sessions.waitSessions", input),
      createSession: (input) => client.call("sessions.createSession", withRequestId(input)),
      forkSession: (input) => client.call("sessions.forkSession", withRequestId(input)),
      sendToSession: (input) => client.call("sessions.sendToSession", withRequestId(input)),
      interruptSession: (input) => client.call("sessions.interruptSession", withRequestId(input)),
      renameSession: (input) => client.call("sessions.renameSession", withRequestId(input)),
      openSession: (input) => client.call("sessions.openSession", input),
      setSessionArchived: (input) =>
        client.call("sessions.setSessionArchived", withRequestId(input)),
      setSessionPinned: (input) => client.call("sessions.setSessionPinned", withRequestId(input)),
    },
    slots: { contribute: (slots) => client.contribute(slots) },
  };
}

export type { ExtensionCapabilityResponse };
