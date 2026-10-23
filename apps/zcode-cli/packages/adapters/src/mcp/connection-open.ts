import { Client } from "@modelcontextprotocol/client";
import type { McpServerConfig, McpServerStatus } from "@zcode/contracts";
import type { McpServerFailureKind } from "@zcode/shared";
import { buildMcpAppsClientCapabilities } from "@zcode/shared/mcp-apps";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import { classifyInteractiveAuthorizationTrigger } from "./oauth-errors.js";
import type { McpInteractiveAuthorizationOutcome } from "./oauth-interactive.js";
import type { InteractiveAuthorizationTrigger } from "./oauth-errors.js";
import {
  type AuthorizationCodeOAuthConfig,
  type McpClient,
  type McpTransport,
} from "./adapter-types.js";
import {
  createStatus,
  isCurrentConnection,
  nextConnectionGeneration,
  updateCurrentRecord,
  type McpRegistryHost,
} from "./connection-registry.js";
import { closeClientAndTransport, type McpTeardownHost } from "./connection-teardown.js";
import {
  installElicitationHandler,
  installNotificationHandlers,
  type McpHandlerHost,
} from "./adapter-handlers.js";
import { replayResourceSubscriptions, type McpResourceHost } from "./resource-operations.js";
import { attachStdioLogging, createTransport, type McpTransportHost } from "./transport-factory.js";
import { McpTimeoutError, withTimeout } from "./timeout.js";
import {
  formatVersionNegotiationMode,
  getStdioTransportExitInfo,
  getStdioTransportPid,
  isProtocolNegotiationFailure,
  isStdioTransportProcessAlive,
  resolveAuthorizationCodeOAuthConfig,
  resolveVersionNegotiation,
} from "./protocol.js";

export interface McpConnectionOpenHost
  extends McpRegistryHost, McpTeardownHost, McpHandlerHost, McpResourceHost, McpTransportHost {
  readonly clientVersion: string;
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

export async function openServerConnection(
  host: McpConnectionOpenHost,
  input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  },
): Promise<McpServerStatus> {
  const {
    config,
    generation,
    name,
    oauthAuthorizationAttempted = false,
    signal,
    timeoutMs,
    workingDirectory,
  } = input;
  const startedAt = Date.now();
  let client: McpClient | undefined;
  let connectDurationMs: number | undefined;
  let getRecentStderr: (() => string | undefined) | undefined;
  let listToolsDurationMs: number | undefined;
  let transport: McpTransport | undefined;
  let failureKind: McpServerFailureKind =
    config.type === "stdio" ? "process_start_failed" : "network_unreachable";

  try {
    const transportBundle = await createTransport(host, config, name, workingDirectory);
    transport = transportBundle.transport;
    getRecentStderr = attachStdioLogging(host, name, transport);
    client = new Client(
      {
        name: host.clientName,
        version: host.clientVersion,
      },
      {
        versionNegotiation: resolveVersionNegotiation(config, timeoutMs),
        capabilities: {
          // MCP Apps 规范：宿主经 `extensions["io.modelcontextprotocol/ui"]` 宣告能渲染的 UI mimeType，
          // 官方 SDK 的 server 据此决定是否下发 ui 资源（getUiCapability）。
          ...buildMcpAppsClientCapabilities(),
          // 只宣告 form 模式（url 模式不做）；server 据此选择 elicitation 形态。
          ...(host.elicitation ? { elicitation: { form: {} } } : {}),
        },
      },
    );
    installElicitationHandler(host, client, name);
    installNotificationHandlers(host, client, name);
    updateCurrentRecord(host, name, generation, {
      client,
      transport,
    });

    const connectStartedAt = Date.now();
    await withTimeout(
      client.connect(transport),
      timeoutMs,
      `MCP server ${name} connection timed out after ${timeoutMs}ms`,
      signal,
    );
    connectDurationMs = Date.now() - connectStartedAt;

    failureKind = "tool_list_failed";
    const listToolsStartedAt = Date.now();
    const listed = await withTimeout(
      client.listTools(),
      timeoutMs,
      `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
      signal,
    );
    listToolsDurationMs = Date.now() - listToolsStartedAt;
    const tools = listed.tools.map((tool) =>
      normalizeMcpToolDescriptor(name, tool, config.timeoutMs, config.alwaysLoad),
    );
    const negotiatedProtocolEra = client.getProtocolEra();
    const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
    const status = createStatus(config, "connected", {
      protocolEra: negotiatedProtocolEra,
      toolCount: tools.length,
    });
    if (!isCurrentConnection(host, name, generation)) {
      await closeClientAndTransport(host, name, client, transport);
      return host.records.get(name)?.status ?? status;
    }
    host.records.set(name, {
      client,
      config,
      status,
      tools,
      transport,
    });
    // A3：重连（同一 adapter 实例）后按登记表重放订阅；首次连接登记表为空，直接跳过。
    await replayResourceSubscriptions(host, name, client);
    const mcpTransportPid = getStdioTransportPid(transport);
    const mcpProcessIdentity =
      mcpTransportPid != null && host.connectionContext
        ? host.processTracker?.recordProcessStarted({
            connectionId: host.connectionContext.mcpConnectionId,
            pid: mcpTransportPid,
          })
        : undefined;
    // stdio MCP 子进程死亡（如 node_repl 被 REPL cell 的异步错误击穿）不能完全
    // 静默——不记日志、状态停留在 connected，后续调用只会抛裸的 "Not connected"。
    // 挂 onclose 把意外断连显式化；主动关闭路径会先清掉 onclose（见 closeClientAndTransport）。
    client.onclose = () => {
      if (!isCurrentConnection(host, name, generation)) return;
      const current = host.records.get(name);
      if (!current || current.client !== client) return;
      nextConnectionGeneration(host, name);
      const recentStderr = getRecentStderr?.();
      const processExit = getStdioTransportExitInfo(transport);
      current.status = createStatus(current.config, "disconnected", {
        error: "MCP server connection closed unexpectedly",
        failureKind: "unexpected_disconnect",
      });
      host.logger?.warn("MCP server connection lost", {
        ...host.connectionContext,
        event: "mcp.server.connection_lost",
        mcpServerName: name,
        ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
        ...mcpProcessIdentity,
        ...(processExit
          ? { exitCode: processExit.exitCode, signal: processExit.signal ?? undefined }
          : {}),
        status: "failed",
        transport: current.config.type,
        ...(recentStderr ? { stderr: recentStderr } : {}),
      });
      if (
        current.config.type === "stdio" &&
        host.connectionContext &&
        (processExit || !isStdioTransportProcessAlive(transport))
      ) {
        host.processTracker?.recordProcessCrashed({
          connectionId: host.connectionContext.mcpConnectionId,
          exitCode: processExit?.exitCode ?? null,
          signal: processExit?.signal ?? null,
        });
      }
    };
    // 此前连接日志只记录 transport，auto 协商后无法判断实际走 modern 还是 legacy。
    // 同时记录配置策略和 SDK 握手结果，避免把 `auto` 误当成最终协议版本。
    // 连接池上下文和 stdio transport PID 过去未进入同一事件，无法关联 session、
    // workspace、协议版本和真实子进程；stdio PID 只代表最终会话 transport，不代表 probe child。
    host.logger?.info("MCP server connected", {
      ...host.connectionContext,
      connectDurationMs,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.connected",
      listToolsDurationMs,
      mcpClientName: host.clientName,
      mcpClientVersion: host.clientVersion,
      mcpProtocolEra: negotiatedProtocolEra ?? "unknown",
      mcpProtocolVersion: negotiatedProtocolVersion ?? "unknown",
      mcpServerName: name,
      ...mcpProcessIdentity,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      mcpVersionNegotiationMode: formatVersionNegotiationMode(config),
      status: "completed",
      toolCount: tools.length,
      transport: config.type,
    });
    return status;
  } catch (error) {
    // 过去这里等的是旧 provider 自己开的 listener，且用 session 的 15 秒预算做
    // 硬关闭——15 秒是 caller 的等待预算，不是授权事务的寿命。现在按错误类型判定是否需要
    // 交互授权，并把授权交给 Phase 2 独立事务（独立锁、fresh DCR、300 秒事务 TTL）。
    const trigger = oauthAuthorizationAttempted
      ? undefined
      : classifyInteractiveAuthorizationTrigger(error);
    const authorizationCodeOAuthConfig =
      trigger && config.type !== "stdio" ? resolveAuthorizationCodeOAuthConfig(config) : undefined;
    if (trigger && authorizationCodeOAuthConfig && config.type !== "stdio") {
      // negotiation 失败时 SDK 已关闭 transport，不可复用；Phase 2 也不需要 transport。
      await closeClientAndTransport(host, name, client, transport);
      const outcome = await host.runInteractiveOAuthAuthorization({
        config,
        generation,
        name,
        oauthConfig: authorizationCodeOAuthConfig,
        serverUrl: config.url,
        signal,
        trigger,
      });
      if (outcome.status === "authorized" || outcome.status === "already-authorized") {
        return await openServerConnection(host, {
          ...input,
          oauthAuthorizationAttempted: true,
        });
      }
      // client/transport 已在进入 Phase 2 前关闭，这里不再传入；failureKind 沿用
      // 诊断分类，让设置页把"授权没完成"与网络/进程类失败区分开。
      return await failConnection(host, {
        config,
        connectDurationMs,
        error:
          outcome.status === "pending"
            ? new Error(
                `MCP server ${name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
              )
            : outcome.error,
        failureKind: "oauth_authorization_failed",
        generation,
        getRecentStderr,
        listToolsDurationMs,
        name,
        startedAt,
      });
    }
    // `protocol_negotiation_failed` 枚举与 UI 文案在 shared/i18n 里早已存在，但 adapter
    // 侧一直没有产出方——auto/pin 模式下 SDK 的 server/discover probe 硬失败（典型：飞书项目
    // MCP 对未知方法回 HTTP 200 + id:null 的非标 JSON-RPC error，body 过不了
    // JSONRPCMessageSchema）会一路落到默认 failureKind "network_unreachable"，设置页因此
    // 显示误导性的"网络不可达"。这里按结构化错误类型（SdkErrorCode / isInstance）识别 SDK
    // 协商失败并产出正确分类，不依赖错误文本；withTimeout 不包装错误（timeout.ts 只透传
    // reject），cause 链仅作防御性兜底。
    const negotiationFailureKind = isProtocolNegotiationFailure(error)
      ? ("protocol_negotiation_failed" as const)
      : undefined;
    return await failConnection(host, {
      client,
      config,
      connectDurationMs,
      error,
      generation,
      getRecentStderr,
      listToolsDurationMs,
      name,
      startedAt,
      transport,
      failureKind: negotiationFailureKind ?? failureKind,
    });
  }
}

export async function failConnection(
  host: McpConnectionOpenHost,
  input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  },
): Promise<McpServerStatus> {
  const {
    client,
    config,
    connectDurationMs,
    error,
    failureKind: fallbackFailureKind,
    generation,
    getRecentStderr,
    listToolsDurationMs,
    name,
    startedAt,
    transport,
  } = input;
  const message = error instanceof Error ? error.message : String(error);
  const failureKind =
    (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
      ? "connection_timeout"
      : undefined) ??
    fallbackFailureKind ??
    "connection_failed";
  const status = createStatus(config, "failed", {
    error: message,
    failureKind,
  });
  const recentStderr = getRecentStderr?.();
  const mcpTransportPid = getStdioTransportPid(transport);
  await closeClientAndTransport(host, name, client, transport);
  if (!isCurrentConnection(host, name, generation)) {
    return host.records.get(name)?.status ?? status;
  }
  host.records.set(name, { config, status, tools: [] });
  host.logger?.warn("MCP server connection failed", {
    ...host.connectionContext,
    connectDurationMs,
    durationMs: Date.now() - startedAt,
    error: message,
    event: "mcp.server.failed",
    listToolsDurationMs,
    mcpServerName: name,
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "failed",
    ...(recentStderr ? { stderr: recentStderr } : {}),
    transport: config.type,
  });
  return status;
}
