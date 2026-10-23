import { randomUUID } from "node:crypto";
import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpElicitationPort,
  McpElicitationTrace,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpNotificationPort,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpResourceSubscriptionRequest,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";
import type { McpServerFailureKind } from "@zcode/shared";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import type { NetworkEgressEnvPolicy } from "./network.js";
import type { InteractiveAuthorizationTrigger } from "./oauth-errors.js";
import type { McpInteractiveAuthorizationOutcome } from "./oauth-interactive.js";
import type { McpOAuthRuntimeOptions } from "./oauth.js";
import { createMcpConnectionPool, type McpConnectionPool } from "./pool.js";
import type { McpConnectionContext } from "./pool-entry.js";
import { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import type { McpProcessTracker } from "./process-tracker.js";
import type { McpDeadline } from "./timeout.js";
import {
  type AuthorizationCodeOAuthConfig,
  type CreateMcpAdapterOptions,
  type McpClient,
  type McpServerRecord,
} from "./adapter-types.js";
import {
  appConnectionSnapshot,
  onAppConnectionInvalidated,
  statuses,
  type McpRegistryHost,
} from "./connection-registry.js";
import type { McpTeardownHost } from "./connection-teardown.js";
import type { McpHandlerHost } from "./adapter-handlers.js";
import {
  failConnection,
  openServerConnection,
  type McpConnectionOpenHost,
} from "./connection-open.js";
import {
  closeAdapter,
  connectConfiguredServers,
  connectServer,
  disconnectServer,
  pingServer,
  refreshAndListTools,
  type McpConnectionLifecycleHost,
} from "./connection-lifecycle.js";
import { resolveConnectedRecord, type McpRecoveryHost } from "./connection-recovery.js";
import { runInteractiveOAuthAuthorization, type McpOAuthRuntimeHost } from "./oauth-runtime.js";
import {
  listResourceTemplates,
  listResources,
  readResource,
  replayResourceSubscriptions,
  resolveForResourceRequest,
  resourceSubscriptionCounts,
  subscribeResource,
  unsubscribeResource,
  unsubscribeResourcesBySubscriber,
  type McpResourceHost,
} from "./resource-operations.js";
import { callToolOnClient, type McpToolCallHost } from "./tool-call.js";
import { callTool } from "./tool-call-orchestration.js";
import type { McpTransportHost } from "./transport-factory.js";

export type { CreateMcpAdapterOptions } from "./adapter-types.js";
export {
  MCP_NOTIFICATION_MESSAGE,
  MCP_NOTIFICATION_RESOURCES_LIST_CHANGED,
  MCP_NOTIFICATION_RESOURCES_UPDATED,
  MCP_NOTIFICATION_TOOLS_LIST_CHANGED,
} from "./adapter-types.js";

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    processTracker: options.processTracker,
    createAdapter: ({ connectionContext, workingDirectory }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpProcessTracker,
  resolvePluginName,
  type McpProcessTracker,
  type McpTrackedProcess,
} from "./process-tracker.js";

class NodeMcpAdapter
  implements
    McpPort,
    McpRegistryHost,
    McpTeardownHost,
    McpHandlerHost,
    McpResourceHost,
    McpTransportHost,
    McpToolCallHost,
    McpOAuthRuntimeHost,
    McpRecoveryHost,
    McpConnectionOpenHost,
    McpConnectionLifecycleHost
{
  readonly adapterInstanceId = randomUUID();
  readonly clientName: string;
  readonly clientVersion: string;
  readonly connectionContext?: McpConnectionContext;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly mcpOAuth?: McpOAuthRuntimeOptions;
  readonly network?: NetworkEgressEnvPolicy;
  readonly processTracker?: McpProcessTracker;
  readonly connectionGenerations = new Map<string, number>();
  readonly records = new Map<string, McpServerRecord>();
  readonly workingDirectory?: string;
  readonly elicitation?: McpElicitationPort;
  readonly notifications?: McpNotificationPort;
  /** 资源订阅登记表 serverName → uri → subscriberKey；唯一 owner，连接层计数。 */
  readonly resourceSubscriptions = new McpResourceSubscriptionRegistry();
  /** 每个 server 当前正在执行的工具调用 trace；elicitation 借此归属到会话 / 工具行。 */
  readonly activeCallTraces = new Map<string, McpElicitationTrace>();
  readonly appConnectionListeners = new Map<string, Set<() => void>>();
  private credentialStore?: SharedZCodeCredentialStore;
  /** tools/list_changed 累计次数，runtime 按此判断是否需要重注册。 */
  private toolListRevisionCounter = 0;

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "zcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.processTracker = options.processTracker;
    this.workingDirectory = options.workingDirectory;
    this.elicitation = options.elicitation;
    this.notifications = options.notifications;
  }

  async connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options: McpConnectOptions = {},
  ): Promise<McpConnectionSnapshot> {
    return await connectConfiguredServers(this, servers, options);
  }

  async connectServer(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpServerStatus> {
    return await connectServer(this, name, config, options);
  }

  async disconnectServer(name: string): Promise<McpServerStatus | undefined> {
    return await disconnectServer(this, name);
  }

  async status(): Promise<Record<string, McpServerStatus>> {
    return statuses(this);
  }

  async pingServer(name: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    return await pingServer(this, name, options);
  }

  toolListRevision(): number {
    return this.toolListRevisionCounter;
  }

  onToolListChanged(serverName: string): void {
    this.toolListRevisionCounter += 1;
    this.notifications?.onNotification({ kind: "toolListChanged", serverName });
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return await refreshAndListTools(this);
  }

  async listResources(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourcesResult> {
    return await listResources(this, request, options);
  }

  async listResourceTemplates(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourceTemplatesResult> {
    return await listResourceTemplates(this, request, options);
  }

  async subscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    await subscribeResource(this, request, options);
  }

  async unsubscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    await unsubscribeResource(this, request, options);
  }

  async unsubscribeResourcesBySubscriber(subscriberKeyPrefix: string): Promise<number> {
    return await unsubscribeResourcesBySubscriber(this, subscriberKeyPrefix);
  }

  /** 登记表快照（测试 / 诊断）：serverName → uri → 订阅者数。 */
  resourceSubscriptionCounts(): Record<string, Record<string, number>> {
    return resourceSubscriptionCounts(this);
  }

  /** 断连重连后按登记表重放 subscribe（A3）；单条失败不影响其它。 */
  async replayResourceSubscriptions(serverName: string, client: McpClient): Promise<void> {
    await replayResourceSubscriptions(this, serverName, client);
  }

  async resolveForResourceRequest(
    serverName: string,
    operation: string,
    options: McpCallToolOptions,
  ): Promise<{
    record: McpServerRecord & { client: McpClient };
    deadline: McpDeadline;
    timeoutMessage: string;
  }> {
    return await resolveForResourceRequest(this, serverName, operation, options);
  }

  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    return await callTool(this, request, options);
  }

  async readResource(
    request: McpReadResourceRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpReadResourceResult> {
    return await readResource(this, request, options);
  }

  async resolveConnectedRecord(
    serverName: string,
    deadline: McpDeadline,
    timeoutMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<McpServerRecord & { client: McpClient }> {
    return await resolveConnectedRecord(this, serverName, deadline, timeoutMessage, signal);
  }

  async callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult> {
    return await callToolOnClient(this, client, request, timeoutMs, signal, onProgress);
  }

  async openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationAttempted?: boolean;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
  }): Promise<McpServerStatus> {
    return await openServerConnection(this, input);
  }

  async failConnection(input: {
    config: McpServerConfig;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    name: string;
    startedAt: number;
  }): Promise<McpServerStatus> {
    return await failConnection(this, input);
  }

  async close(): Promise<void> {
    await closeAdapter(this);
  }

  onAppConnectionInvalidated(name: string, listener: () => void): () => void {
    return onAppConnectionInvalidated(this, name, listener);
  }

  appConnectionSnapshot(name: string): { identity: string; generation: number } | null {
    return appConnectionSnapshot(this, name);
  }

  resolveCredentialStore(): SharedZCodeCredentialStore {
    this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedZCodeCredentialStore();
    return this.credentialStore;
  }

  async runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome> {
    return await runInteractiveOAuthAuthorization(this, input);
  }
}
