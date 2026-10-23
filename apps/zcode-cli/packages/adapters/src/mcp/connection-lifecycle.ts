import { isDeepStrictEqual } from "node:util";
import type {
  McpConnectOptions,
  McpConnectionSnapshot,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import { getUnsupportedMcpAuthError } from "./config-auth.js";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  MCP_PING_TIMEOUT_MS,
  type McpServerRecord,
} from "./adapter-types.js";
import {
  createStatus,
  isCurrentConnection,
  nextConnectionGeneration,
  statuses,
  type McpRegistryHost,
} from "./connection-registry.js";
import { closeRecord, type McpTeardownHost } from "./connection-teardown.js";
import { waitForSharedConnection } from "./connection-recovery.js";
import { isPeerAnsweredError } from "./protocol.js";

export interface McpConnectionLifecycleHost extends McpRegistryHost, McpTeardownHost {
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
  }): Promise<McpServerStatus>;
}

export async function connectConfiguredServers(
  host: McpConnectionLifecycleHost,
  servers: Record<string, McpServerConfig>,
  options: McpConnectOptions = {},
): Promise<McpConnectionSnapshot> {
  const startedAt = Date.now();
  const serverNames = Object.keys(servers);
  host.logger?.info("MCP configured servers connection started", {
    event: "mcp.configured_servers.connect.started",
    serverCount: serverNames.length,
    serverNames,
    status: "started",
  });
  const configuredNames = new Set(Object.keys(servers));
  await Promise.all(
    Array.from(host.records.keys())
      .filter((name) => !configuredNames.has(name))
      .map((name) => disconnectServer(host, name)),
  );

  await Promise.all(
    Object.entries(servers).map(([name, config]) => {
      const record = host.records.get(name);
      if (
        record?.connecting &&
        record.status.status === "connecting" &&
        record.status.authorization &&
        isDeepStrictEqual(record.config, config)
      ) {
        // 相同配置的全量收敛可能与 OAuth callback 等待重叠；重新 connect
        // 会关闭原 session，使浏览器中已打开的授权 URL、PKCE/state 和 callback 一并失效。
        // 连接生命周期可以共享，但 Session 的 15 秒等待预算和 AbortSignal 不能继承设置页的 5 分钟预算。
        return waitForSharedConnection(host, name, record, options);
      }
      return host.connectServer(name, config, options);
    }),
  );

  const statusMap = statuses(host);
  const tools = await refreshAndListTools(host);
  const statusCounts = Object.values(statusMap).reduce<Record<string, number>>((counts, status) => {
    counts[status.status] = (counts[status.status] ?? 0) + 1;
    return counts;
  }, {});
  host.logger?.info("MCP configured servers connection completed", {
    durationMs: Date.now() - startedAt,
    event: "mcp.configured_servers.connect.completed",
    serverCount: serverNames.length,
    status: "completed",
    statusCounts,
    toolCount: tools.length,
  });
  return {
    statuses: statusMap,
    tools,
  };
}

export async function connectServer(
  host: McpConnectionLifecycleHost,
  name: string,
  config: McpServerConfig,
  options: McpConnectOptions = {},
): Promise<McpServerStatus> {
  const startedAt = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const generation = nextConnectionGeneration(host, name);
  host.logger?.info("MCP server connection started", {
    event: "mcp.server.connect.started",
    mcpServerName: name,
    status: "started",
    timeoutMs,
    transport: config.type,
  });
  await closeRecord(host, name);

  if (config.enabled === false) {
    const status = createStatus(config, "disabled");
    host.records.set(name, { config, status, tools: [] });
    host.logger?.info("MCP server connection skipped", {
      durationMs: Date.now() - startedAt,
      event: "mcp.server.connect.skipped",
      mcpServerName: name,
      status: "completed",
      transport: config.type,
    });
    return status;
  }

  const authError = getUnsupportedMcpAuthError(config);
  if (authError) {
    const status = createStatus(config, "failed", {
      error: authError,
      failureKind: "connection_failed",
    });
    host.records.set(name, { config, status, tools: [] });
    return status;
  }

  const abortController = new AbortController();
  const abortExternal = () => {
    abortController.abort(
      options.signal?.reason instanceof Error ? options.signal.reason : undefined,
    );
  };
  if (options.signal?.aborted) {
    abortExternal();
  } else {
    options.signal?.addEventListener("abort", abortExternal, { once: true });
  }

  const connectingStatus = createStatus(config, "connecting");
  const record: McpServerRecord = {
    abortController,
    config,
    status: connectingStatus,
    tools: [],
  };
  host.records.set(name, record);
  const connecting = host
    .openServerConnection({
      config,
      generation,
      name,
      signal: abortController.signal,
      timeoutMs,
      workingDirectory: options.workingDirectory,
    })
    .finally(() => {
      options.signal?.removeEventListener("abort", abortExternal);
    });
  record.connecting = connecting;
  // 过去 `oauthAuthorizationTimeoutMs`（session 的 15 秒）被当成 OAuth 事务寿命，
  // 15 秒后连同 callback listener 一起关掉，真人根本来不及在浏览器里完成授权（现场证据：
  // 一次成功授权耗时约 74 秒）。现在它只作为**本 caller 的等待预算**：到点返回当时的
  // snapshot（含授权 URL），后台连接与 300 秒授权事务继续存活。
  return await waitForSharedConnection(host, name, record, options);
}

export async function disconnectServer(
  host: McpConnectionLifecycleHost,
  name: string,
): Promise<McpServerStatus | undefined> {
  const record = host.records.get(name);
  if (!record) return undefined;

  nextConnectionGeneration(host, name);
  await closeRecord(host, name);
  const status = createStatus(record.config, "disconnected");
  host.records.set(name, {
    config: record.config,
    status,
    tools: [],
  });
  return status;
}

// HTTP/SSE MCP 服务被停掉时不会派发 onclose（没有常驻流可断），record 会长期停在
// connected；设置页刷新读到的就是这份"无声死亡"的旧快照，看起来像刷新按钮没生效。
// ping 是 MCP 基础协议方法，用它把 transport 存活性显式化。
export async function pingServer(
  host: McpConnectionLifecycleHost,
  name: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const record = host.records.get(name);
  if (!record?.client || record.status.status !== "connected") {
    return false;
  }
  const timeoutMs = Math.min(
    options.timeoutMs ?? MCP_PING_TIMEOUT_MS,
    record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
  );
  const generation = host.connectionGenerations.get(name) ?? 0;
  try {
    await record.client.ping({ timeout: timeoutMs });
    return true;
  } catch (error) {
    // server 回了 JSON-RPC 错误（例如未实现 ping）说明连接本身是活的，不能据此拆连接。
    if (isPeerAnsweredError(error)) {
      return true;
    }
    if (!isCurrentConnection(host, name, generation)) return false;
    const current = host.records.get(name);
    if (current && current.client === record.client) {
      current.status = createStatus(current.config, "disconnected", {
        error: "MCP server did not answer ping",
        failureKind: "unexpected_disconnect",
      });
    }
    host.logger?.warn("MCP server ping failed", {
      ...host.connectionContext,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.server.ping.failed",
      mcpServerName: name,
      status: "failed",
      transport: record.config.type,
    });
    return false;
  }
}

export async function refreshAndListTools(
  host: McpConnectionLifecycleHost,
): Promise<McpToolDescriptor[]> {
  for (const [name, record] of host.records) {
    if (!record.toolsStale || !record.client || record.status.status !== "connected") continue;
    try {
      const listed = await record.client.listTools();
      record.tools = listed.tools.map((tool) =>
        normalizeMcpToolDescriptor(name, tool, record.config.timeoutMs),
      );
      record.status = { ...record.status, toolCount: record.tools.length };
      record.toolsStale = false;
      host.logger?.info("MCP tool list refreshed after list_changed", {
        event: "mcp.tools.refreshed",
        mcpServerName: name,
        toolCount: record.tools.length,
      });
    } catch (error) {
      host.logger?.warn("MCP tool list refresh failed", {
        event: "mcp.tools.refresh_failed",
        mcpServerName: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Array.from(host.records.values()).flatMap((record) => record.tools);
}

export async function closeAdapter(host: McpConnectionLifecycleHost): Promise<void> {
  const startedAt = Date.now();
  const serverCount = host.records.size;
  for (const name of host.records.keys()) {
    nextConnectionGeneration(host, name);
  }
  await Promise.all(Array.from(host.records.keys()).map((name) => closeRecord(host, name)));
  host.records.clear();
  host.logger?.info("MCP adapter closed", {
    durationMs: Date.now() - startedAt,
    event: "mcp.adapter.closed",
    serverCount,
    status: "completed",
  });
}
