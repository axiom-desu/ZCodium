import type { BrowserControlPort } from "@zcode/contracts";
import type {
  McpElicitationRequest,
  McpElicitationResult,
  McpServerNotification,
} from "@zcode/contracts";
import { requestMcpElicitation } from "./interaction-broker.js";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import { parseConversationTopic } from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import { ProtocolRuntimeResources } from "./runtime-resources.js";
import { routeMcpServerNotification } from "./mcp-ui/index.js";
import {
  V4InteractionRegistry,
  resolveV4InteractionRegistryOptionsFromEnv,
} from "../zcode-protocol-v4/interaction-registry.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { createSessionResidentPoolHost } from "./session-residency.js";
import {
  DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT,
  SessionResidentPool,
} from "./session-resident-pool.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import {
  createProtocolLogger,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  ProtocolRequestError,
  toProtocolError,
  type ZCodeProtocolAgentDependencies,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createInMemorySessionEventStore } from "@zcode/contracts";
import { dispatchLegacyRequest } from "./server-dispatch-legacy.js";
import { dispatchV4Request } from "./server-dispatch-v4.js";
import {
  UNHANDLED_REQUEST,
  type ProtocolRequestDispatchHost,
  type ZCodeProtocolOutboundMessage,
  type ZCodeProtocolPostResponseBatch,
} from "./server-dispatch-types.js";
import { ProtocolClientRequestTable } from "./server-client-requests.js";

export type { ZCodeProtocolAgentDependencies, ZCodeProtocolSessionRecord };
function collectResidencySessionIds(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const candidate = params as {
    commands?: unknown;
    sessionId?: unknown;
    topic?: unknown;
  };
  const sessionIds = new Set<string>();
  if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) {
    sessionIds.add(candidate.sessionId);
  }
  if (typeof candidate.topic === "string") {
    const topicSessionId = parseConversationTopic(candidate.topic);
    if (topicSessionId) sessionIds.add(topicSessionId);
  }
  if (Array.isArray(candidate.commands)) {
    for (const command of candidate.commands) {
      if (!command || typeof command !== "object") continue;
      const sessionId = (command as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }
  return [...sessionIds];
}

export class ZCodeProtocolAgentServer {
  private readonly runtimeResources: ProtocolRuntimeResources;
  private shutdownPromise?: Promise<void>;
  readonly browserControlPort: BrowserControlPort;
  /**
   * 官方 MCP 身份头端口所需的最小上下文。
   * MCP 连接池的构造早于 server，需要在 server 就绪后回填闭包持有的引用——
   * 与 v4Gateway 同样的构造顺序收口方式。只暴露 requestClient，不外泄整个 context。
   */
  /** MCP server 发起的 elicitation/create → 用户提问。 */
  requestMcpElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult> {
    return requestMcpElicitation(this.context, request, options);
  }

  /** MCP server 通知 → 会话 live 事件 / agent 日志。 */
  handleMcpNotification(notification: McpServerNotification): void {
    routeMcpServerNotification(this.context, notification);
  }

  private messageSink?: (message: ZCodeProtocolOutboundMessage) => void;
  private readonly context: ZCodeProtocolAgentServerContext;
  private readonly logger;
  /** 反向 RPC 登记表：仍是唯一 pending 事实，只是由专门对象按同一顺序维护。 */
  private readonly clientRequests: ProtocolClientRequestTable;
  /** 分派层端口：只暴露 context / gateway / outbox / 两张 operation 表。 */
  private readonly dispatchHost: ProtocolRequestDispatchHost;
  private readonly pluginOperationControllers = new Map<string, AbortController>();
  private readonly workspaceGenerateTextControllers = new Map<string, AbortController>();
  /**
   * subscribe initial frame 按 JSON-RPC request id 隔离。connection 必须先 take，
   * 再写 response line，最后按数组顺序写 notification，不能靠 microtask 猜时序。
   */
  private readonly postResponseOutbox = new Map<
    ZCodeProtocolRequestId,
    ZCodeProtocolPostResponseBatch
  >();

  constructor(deps: ZCodeProtocolAgentDependencies) {
    this.runtimeResources = new ProtocolRuntimeResources(deps.createZCodeApp);
    this.clientRequests = new ProtocolClientRequestTable({
      getSink: () => this.messageSink,
    });
    const resolvedDeps = {
      ...deps,
      createZCodeApp: this.runtimeResources.create,
      // 默认 turn 窗口保留策略。
      createSessionEventStore:
        deps.createSessionEventStore ?? (() => createInMemorySessionEventStore()),
      workspaceHookPolicyProvider:
        deps.workspaceHookPolicyProvider ?? new InMemoryWorkspaceHookPolicyProvider(),
    };
    this.logger = createProtocolLogger(resolvedDeps);
    this.context = {
      assertServing: () => this.runtimeResources.assertServing(),
      deps: resolvedDeps,
      logger: this.logger,
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        // 动态工作流灰度门 fail-closed：Host 必须显式 workspace/updateDynamicWorkflowPolicy
        // 才开启。
        dynamicWorkflowEnabled: false,
      },
      notify: (notification) => this.messageSink?.(notification),
      requestClient: (method, params, resultSchema, options) =>
        this.clientRequests.request(method, params, resultSchema, options),
      sessions: new Map<string, ZCodeProtocolSessionRecord>(),
      // 交互应答登记表（broker 反向请求 × v4 resolveInteraction 命令的汇合点）。
      v4Interactions: new V4InteractionRegistry(
        resolveV4InteractionRegistryOptionsFromEnv(deps.env ?? process.env),
      ),
    };
    this.dispatchHost = {
      context: this.context,
      requireV4Gateway: () => this.requireV4Gateway(),
      setPostResponseBatch: (requestId, batch) => {
        this.postResponseOutbox.set(requestId, batch);
      },
      pluginOperationControllers: this.pluginOperationControllers,
      workspaceGenerateTextControllers: this.workspaceGenerateTextControllers,
    };
    // v4 通道：gateway 闭包持有 context 做帧出口与命令副作用，构造完立即挂回。
    this.context.v4Gateway = createConversationV4Gateway(this.context);
    this.browserControlPort = createProtocolBrowserControlBroker(this.context);
    const sessionResidentTargetCount =
      deps.sessionResidentPoolOptions?.targetCount ?? deps.sessionResidentTargetCount;
    const sessionResidentHighWaterCount =
      deps.sessionResidentPoolOptions?.highWaterCount ??
      (sessionResidentTargetCount === undefined
        ? undefined
        : Math.max(DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT, sessionResidentTargetCount));
    // 单 CLI resident session 池：协议 request release 主动收敛，资源 sampler 只作兜底。
    this.context.sessionResidentPool = new SessionResidentPool(
      createSessionResidentPoolHost(this.context),
      {
        ...deps.sessionResidentPoolOptions,
        // legacy target 曾同时覆盖 high/low，导致迟滞窗口塌为 0；只覆盖 low。
        // 仅配置 target 且超过默认 high 时抬升隐式 high，显式非法组合仍由 pool 拒绝。
        highWaterCount: sessionResidentHighWaterCount,
        targetCount: sessionResidentTargetCount,
      },
    );
  }

  /** 低频 sampler 兜底入口；正常收敛由每个协议 request 的 operation lease 释放触发。 */
  rebalanceResidentSessions(): void {
    this.context.sessionResidentPool?.rebalance();
  }

  /**
   * 借同一 60s 节拍做 event store 的时间兜底淘汰：
   * subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。返回淘汰条数。
   */
  pruneSessionEventStores(nowMs: number = Date.now()): number {
    let evicted = 0;
    for (const record of this.context.sessions.values()) {
      evicted += record.eventStore.pruneTransientEvents?.(nowMs) ?? 0;
    }
    return evicted;
  }

  /** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */
  pruneDetachedChildPublishers(nowMs: number = Date.now()): number {
    return this.context.v4Gateway?.pruneDetachedChildPublishers(nowMs) ?? 0;
  }

  /**
   * 内存诊断计数器，随 60s 资源采样写本地日志。
   * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    let eventRows = 0;
    let eventEvicted = 0;
    let eventTransientRetained = 0;
    for (const record of this.context.sessions.values()) {
      const stats = record.eventStore.getStats?.();
      eventRows += stats?.events ?? 0;
      eventEvicted += stats?.evictedEvents ?? 0;
      eventTransientRetained += stats?.retainedTransient ?? 0;
    }
    const counters: Record<string, number> = {
      sessions: this.context.sessions.size,
      eventRows,
      eventEvicted,
      eventTransientRetained,
    };
    const v4 = this.context.v4Gateway?.collectMemoryDiagnostics();
    if (v4) {
      for (const [key, value] of Object.entries(v4)) {
        counters[`v4.${key}`] = value;
      }
    }
    return counters;
  }

  setNotificationSink(sink: (message: ZCodeProtocolOutboundMessage) => void): void {
    this.runtimeResources.assertServing();
    this.clientRequests.clearDisconnectError();
    this.messageSink = sink;
  }

  disconnectClient(error: Error): void {
    // 连接关闭后反向请求已不可能收到响应，必须先结束 pending，
    // 否则正在物化 Session 的 handler 会阻塞 connection 的关闭流程。
    this.clientRequests.disconnect(error);
  }

  /** 进程资源关闭，不使用会删除产品会话/发布 session.removed 的 session/close。 */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runtimeResources.close();
    const error = new Error("ZCode Protocol runtime stopping");
    this.disconnectClient(error);
    this.messageSink = undefined;
    this.clearPostResponseMessages();
    for (const controller of this.pluginOperationControllers.values()) controller.abort(error);
    for (const controller of this.workspaceGenerateTextControllers.values())
      controller.abort(error);
    for (const record of this.context.sessions.values()) {
      record.activeAbortController?.abort(error);
      try {
        record.unsubscribe?.();
      } catch {
        this.logger?.warn("Session unsubscribe failed during protocol shutdown", {
          event: "zcode_protocol.session.unsubscribe.failed",
        });
      }
    }
    return this.shutdownPromise;
  }

  /** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */
  disposeProjections(): void {
    this.context.v4Gateway?.dispose();
    this.context.sessions.clear();
  }

  /** 一次性取走某 request 的 post-response messages；重复 take 返回空数组。 */
  takePostResponseMessages(requestId: ZCodeProtocolRequestId): ZCodeProtocolOutboundMessage[] {
    const batch = this.takePostResponseBatch(requestId);
    batch?.commit();
    return [...(batch?.messages ?? [])];
  }

  /** production NDJSON 取完整 batch；只有全部 write 成功后才调 commit。 */
  takePostResponseBatch(requestId: ZCodeProtocolRequestId): ZCodeProtocolPostResponseBatch | null {
    const batch = this.postResponseOutbox.get(requestId) ?? null;
    this.postResponseOutbox.delete(requestId);
    return batch;
  }

  /** connection close / server dispose 时释放尚未写出的 initial frame 引用。 */
  clearPostResponseMessages(): void {
    this.postResponseOutbox.clear();
  }

  async handleMessage(
    message: ZCodeProtocolMessage,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined> {
    this.runtimeResources.assertServing();
    if (isResponse(message)) {
      this.clientRequests.resolve(message.id, message.result);
      return undefined;
    }
    if (isErrorResponse(message)) {
      this.clientRequests.reject(
        message.id,
        new ProtocolRequestError(message.error.code, message.error.message, message.error.data),
      );
      return undefined;
    }
    if (isRequest(message)) {
      return await this.handleRequest(message);
    }
    if (isNotification(message)) {
      this.logger?.debug("ZCode Protocol notification ignored", {
        event: "zcode_protocol.notification.ignored",
        method: message.method,
        module: "bootstrap.zcode_protocol",
      });
    }
    return undefined;
  }

  private async handleRequest(
    request: ZCodeProtocolRequest,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse> {
    // request id 可在前一请求完成后复用；新请求不能继承未消费的旧 outbox。
    this.postResponseOutbox.delete(request.id);
    let releaseResidencyOperation: (() => void) | undefined;
    try {
      // subscribe hydration、workspace 配置与 resume 都可能跨 await。若只看
      // session 当前状态，sampler 会在 handler 持有旧 record 时把它关闭。进程级 lease
      // 覆盖整个 request；能识别的 sessionIds 额外用于冷恢复闸门与 LRU touch。
      releaseResidencyOperation = await this.context.sessionResidentPool?.acquireOperation(
        collectResidencySessionIds(request.params),
      );
      const result = await this.dispatchRequest(request);
      return this.ok(request.id, result);
    } catch (error) {
      this.postResponseOutbox.delete(request.id);
      const protocolError = toProtocolError(error);
      return this.fail(request.id, protocolError.code, protocolError.message, protocolError.data);
    } finally {
      releaseResidencyOperation?.();
    }
  }

  private requireV4Gateway(): NonNullable<ZCodeProtocolAgentServerContext["v4Gateway"]> {
    if (!this.context.v4Gateway) {
      throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
    }
    return this.context.v4Gateway;
  }

  private async dispatchRequest(request: ZCodeProtocolRequest) {
    // 分派顺序固定：v4 竖切先判定，未命中才落到旧 namespace。
    // 两层都只返回结果，method-not-found 由这里统一抛出，错误码与文案不变。
    const v4Result = await dispatchV4Request(this.dispatchHost, request);
    if (v4Result !== UNHANDLED_REQUEST) return v4Result;
    const legacyResult = await dispatchLegacyRequest(this.dispatchHost, request);
    if (legacyResult !== UNHANDLED_REQUEST) return legacyResult;
    throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
  }

  private ok(id: ZCodeProtocolRequestId, result: unknown): ZCodeProtocolResponse {
    return { id, result };
  }

  private fail(
    id: ZCodeProtocolRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): ZCodeProtocolError {
    return { error: { code, data, message }, id };
  }
}
