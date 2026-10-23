import { isDeepStrictEqual } from "node:util";
import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
} from "@zcode/contracts";
import type { McpServerFailureKind } from "@zcode/shared";
import type { InteractiveAuthorizationTrigger } from "./oauth-errors.js";
import type { McpInteractiveAuthorizationOutcome } from "./oauth-interactive.js";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  type AuthorizationCodeOAuthConfig,
  type McpClient,
  type McpServerRecord,
} from "./adapter-types.js";
import {
  createStatus,
  nextConnectionGeneration,
  type McpRegistryHost,
} from "./connection-registry.js";
import { closeClientAndTransport, type McpTeardownHost } from "./connection-teardown.js";
import type { McpToolCallHost } from "./tool-call.js";
import { remainingMcpDeadlineMs, waitWithinMcpDeadline, type McpDeadline } from "./timeout.js";
import { resolveAuthorizationCodeOAuthConfig } from "./protocol.js";

export interface McpRecoveryHost extends McpRegistryHost, McpTeardownHost, McpToolCallHost {
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult>;
  failConnection(input: {
    config: McpServerConfig;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    name: string;
    startedAt: number;
  }): Promise<McpServerStatus>;
  openServerConnection(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthAuthorizationAttempted?: boolean;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<McpServerStatus>;
  runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome>;
}

export function waitForSharedConnection(
  host: McpRegistryHost,
  name: string,
  record: McpServerRecord,
  options: McpConnectOptions,
): Promise<McpServerStatus> {
  const connecting = record.connecting;
  if (!connecting) return Promise.resolve(record.status);
  if (options.oauthAuthorizationTimeoutMs === undefined && !options.signal) {
    return connecting;
  }

  let abortHandler: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const currentStatus = () => host.records.get(name)?.status ?? record.status;
  const waiters: Promise<McpServerStatus>[] = [connecting];

  const timeoutMs = options.oauthAuthorizationTimeoutMs;
  if (timeoutMs !== undefined) {
    waiters.push(
      new Promise((resolvePromise) => {
        timeoutId = setTimeout(() => resolvePromise(currentStatus()), timeoutMs);
      }),
    );
  }
  if (options.signal) {
    waiters.push(
      new Promise((resolvePromise) => {
        if (options.signal?.aborted) {
          resolvePromise(currentStatus());
          return;
        }
        abortHandler = () => resolvePromise(currentStatus());
        options.signal?.addEventListener("abort", abortHandler, {
          once: true,
        });
      }),
    );
  }

  return Promise.race(waiters).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
  });
}

/**
 * callTool / readResource 共用：等待共享 connecting 任务、对已断连 record 重连一次、
 * 返回处于 connected 的 record。抽出来是为了让资源读取与工具调用走完全相同的恢复路径。
 */
export async function resolveConnectedRecord(
  host: McpRecoveryHost,
  serverName: string,
  deadline: McpDeadline,
  timeoutMessage: string,
  signal: AbortSignal | undefined,
): Promise<McpServerRecord & { client: McpClient }> {
  const pending = host.records.get(serverName)?.connecting;
  if (pending) {
    // 修复原因：connecting 是 adapter 持有的共享连接/OAuth 恢复任务。过去这里裸 await，
    // tool caller 的 timeout/abort 完全失效；但直接 abort 底层任务又会关闭其他 caller 共用的
    // callback listener。这里只限制当前 waiter，共享任务继续由 record 生命周期持有。
    await waitWithinMcpDeadline(pending, deadline, timeoutMessage, signal);
  }

  // Bugfix：stdio MCP 子进程死亡后（如 node_repl 被异步错误击穿），此前没有任何恢复路径：
  // 连接只在 session 创建时建立一次，session resume 也不重建，该会话的工具从此永远失败。
  // 这里在调用前对已断连的 record 重连一次；server 进程内状态（如 REPL 变量）不可恢复，
  // 但工具本身恢复可用。
  const disconnected = host.records.get(serverName);
  if (disconnected && disconnected.status.status === "disconnected") {
    await waitWithinMcpDeadline(
      reconnectForCall(host, serverName, disconnected.config),
      deadline,
      timeoutMessage,
      signal,
    );
  }

  const record = host.records.get(serverName);
  if (!record?.client || record.status.status !== "connected") {
    throw new Error(`MCP server is not connected: ${serverName}`);
  }
  return record as McpServerRecord & { client: McpClient };
}

export async function reconnectForCall(
  host: McpRecoveryHost,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  host.logger?.warn("MCP server reconnecting after lost connection", {
    event: "mcp.server.reconnect.started",
    mcpServerName: name,
    status: "started",
    transport: config.type,
  });
  await host.connectServer(name, config);
}

/**
 * 运行期认证恢复：Phase 2 交互授权 → Phase 1 重连 → 原 tool call 最多安全重试一次。
 *
 * 与建连期共用 `runInteractiveOAuthAuthorization`，因此单飞、fencing、caller 预算语义完全一致。
 */
export async function recoverToolCallAuthorization(
  host: McpRecoveryHost,
  input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    onProgress?: McpCallToolOptions["onProgress"];
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpToolCallResult> {
  const { record, request } = input;
  const config = record.config;
  if (config.type === "stdio") throw input.error;
  const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
  if (!oauthConfig) throw input.error;

  host.logger?.warn("MCP tool call requires OAuth authorization", {
    event: "mcp.oauth.tool_call.authorization_required",
    mcpServerName: request.serverName,
    oauthTriggerReason: input.trigger.reason,
    status: "started",
    toolName: request.toolName,
  });

  const recovery = ensureToolCallAuthorizationRecovery(host, {
    config,
    name: request.serverName,
    oauthConfig,
    record,
    trigger: input.trigger,
  });
  const recoveredStatus = await waitWithinMcpDeadline(
    recovery,
    input.deadline,
    input.timeoutMessage,
    input.signal,
  );
  if (recoveredStatus.status !== "connected") {
    throw input.error;
  }

  const revived = host.records.get(request.serverName);
  if (!revived?.client || revived.status.status !== "connected") throw input.error;
  return await host.callToolOnClient(
    revived.client,
    request,
    remainingMcpDeadlineMs(input.deadline, input.timeoutMessage),
    input.signal,
    input.onProgress,
  );
}

/**
 * 创建或复用运行期 OAuth 恢复。完整的 Phase 2 → Phase 1 由 adapter-owned record 持有；
 * tool caller 只能等待，不能用自己的 AbortSignal 终止共享事务。
 */
function ensureToolCallAuthorizationRecovery(
  host: McpRecoveryHost,
  input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpServerStatus> {
  const current = host.records.get(input.name);
  if (
    current?.connecting &&
    current.status.status === "connecting" &&
    isDeepStrictEqual(current.config, input.config)
  ) {
    return current.connecting;
  }

  const generation = nextConnectionGeneration(host, input.name);
  const abortController = new AbortController();
  const recoveryRecord: McpServerRecord = {
    abortController,
    config: input.config,
    status: createStatus(input.config, "connecting", {
      toolCount: input.record.tools.length,
    }),
    // 运行期工具已经向 core 广告；恢复期间保留 descriptor，避免设置页/借用端口误判工具消失。
    tools: input.record.tools,
  };
  host.records.set(input.name, recoveryRecord);
  const connecting = runToolCallAuthorizationRecovery(host, {
    abortController,
    config: input.config,
    generation,
    name: input.name,
    oauthConfig: input.oauthConfig,
    previousClient: input.record.client,
    previousTransport: input.record.transport,
    trigger: input.trigger,
  });
  recoveryRecord.connecting = connecting;
  return connecting;
}

async function runToolCallAuthorizationRecovery(
  host: McpRecoveryHost,
  input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpServerRecord["transport"];
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpServerStatus> {
  const startedAt = Date.now();
  try {
    // 原 transport 的握手与 token 已失效，必须由共享 owner 统一退休；不能调用 connectServer，
    // 否则 closeRecord 会 abort recoveryRecord 自己的 controller，形成自取消。
    await closeClientAndTransport(host, input.name, input.previousClient, input.previousTransport);
    const outcome = await host.runInteractiveOAuthAuthorization({
      config: input.config,
      generation: input.generation,
      name: input.name,
      oauthConfig: input.oauthConfig,
      serverUrl: input.config.url,
      signal: input.abortController.signal,
      trigger: input.trigger,
    });
    if (outcome.status === "authorized" || outcome.status === "already-authorized") {
      return await host.openServerConnection({
        config: input.config,
        generation: input.generation,
        name: input.name,
        oauthAuthorizationAttempted: true,
        signal: input.abortController.signal,
        timeoutMs: input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      });
    }
    return await host.failConnection({
      config: input.config,
      error:
        outcome.status === "pending"
          ? new Error(
              `MCP server ${input.name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
            )
          : outcome.error,
      failureKind: "oauth_authorization_failed",
      generation: input.generation,
      name: input.name,
      startedAt,
    });
  } catch (error) {
    // 防御边界：共享 recovery promise 必须是 total operation。任何未来新增的编排异常也只能
    // 收敛为 failed record，不能留下 rejected connecting promise 污染后续 snapshot。
    return await host.failConnection({
      config: input.config,
      error,
      failureKind: "oauth_authorization_failed",
      generation: input.generation,
      name: input.name,
      startedAt,
    });
  }
}
