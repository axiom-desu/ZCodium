import { randomUUID } from "node:crypto";
import type {
  Logger,
  McpConnectOptions,
  McpPort,
  McpServerConfig,
  McpServerStatus,
} from "@zcode/contracts";
import type { McpProcessTracker } from "./process-tracker.js";

export interface McpConnectionContext {
  mcpConnectionId: string;
  mcpIsolation: "session" | "workspace";
  sessionId?: string;
  workspaceKey?: string;
}

export interface CreateMcpAdapterForPoolInput {
  connectionContext: McpConnectionContext;
  config: McpServerConfig;
  serverName: string;
  workingDirectory?: string;
}

export interface PoolEntry {
  adapter: McpPort;
  closeTimer?: ReturnType<typeof setTimeout>;
  connectionContext: McpConnectionContext;
  connecting: Promise<McpServerStatus>;
  key: string;
  refs: Set<string>;
  /** 同一 entry 的并发存活校验共享一次探测，避免重复 ping / 重复重连。 */
  revalidating?: Promise<void>;
  serverName: string;
}

interface PoolEntryLifecycleOptions {
  entries: Map<string, PoolEntry>;
  idleGraceMs: number;
  logger?: Logger;
  processTracker?: McpProcessTracker;
}

export function createPoolEntryLifecycle(options: PoolEntryLifecycleOptions): {
  closeEntry(entry: PoolEntry): Promise<void>;
  revalidateEntry(
    entry: PoolEntry,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<void>;
  scheduleClose(entry: PoolEntry): void;
} {
  const { entries, idleGraceMs, logger, processTracker } = options;

  const closeEntry = async (entry: PoolEntry): Promise<void> => {
    const startedAt = Date.now();
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    try {
      await entry.adapter.close();
      logger?.info("MCP pooled connection closed", {
        ...entry.connectionContext,
        durationMs: Date.now() - startedAt,
        event: "mcp.pool.connection.closed",
        mcpServerName: entry.serverName,
        status: "completed",
      });
    } catch (error) {
      logger?.warn("MCP pooled connection close failed", {
        ...entry.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.pool.connection.close.failed",
        mcpServerName: entry.serverName,
      });
    } finally {
      processTracker?.unregisterConnection({
        connectionId: entry.connectionContext.mcpConnectionId,
      });
    }
  };

  const scheduleClose = (entry: PoolEntry): void => {
    if (entry.closeTimer) return;
    if (idleGraceMs <= 0) {
      void closeEntry(entry);
      return;
    }
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = undefined;
      if (entry.refs.size === 0) void closeEntry(entry);
    }, idleGraceMs);
    entry.closeTimer.unref?.();
  };

  // 设置页的 mcpPort 是进程级的 `protocol-settings` lease，connectionKey 只由
  // serverName + leaseId + config 组成，配置没变时每次 mcp/list 都命中同一个 entry 并直接返回
  // 首次连接那个早已 resolve 的 promise——不重连、不探测、不打日志。HTTP/SSE MCP 被停掉又不会
  // 派发 onclose，于是设置页永远显示"已连接并可用"，点多少次刷新都不变。
  // 这里在显式要求 revalidate 时先确认连接仍然存活，已死则在同一个 entry 上原地重连
  // （保持 entry 身份，其他共享该连接的 lease 不会被打断成 "not leased"）。
  const revalidateEntry = async (
    entry: PoolEntry,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<void> => {
    if (entry.revalidating) {
      await entry.revalidating;
      return;
    }
    const run = (async () => {
      const connected = await entry.connecting.then(
        () => true,
        () => false,
      );
      const state = connected
        ? (await entry.adapter.status())[entry.serverName]?.status
        : undefined;
      // 进行中的握手（含 OAuth 待授权）和显式停用/待信任状态不打扰：
      // 重连会作废浏览器里已打开的授权 URL 和 PKCE/state。
      if (state === "connecting" || state === "disabled" || state === "untrusted") {
        return;
      }
      if (state === "connected") {
        const alive = (await entry.adapter.pingServer?.(entry.serverName)) ?? true;
        if (alive) {
          logger?.debug("MCP pooled connection revalidated", {
            ...entry.connectionContext,
            event: "mcp.pool.connection.revalidated",
            mcpServerName: entry.serverName,
            status: "completed",
          });
          return;
        }
      }
      logger?.warn("MCP pooled connection is stale; reconnecting", {
        ...entry.connectionContext,
        event: "mcp.pool.connection.stale",
        mcpConnectionState: state ?? "unknown",
        mcpServerName: entry.serverName,
        status: "started",
      });
      entry.connecting = entry.adapter.connectServer(entry.serverName, config, connectOptions);
      // 失败由 status()/调用方 await entry.connecting 表达，这里不重复冒泡。
      await entry.connecting.catch(() => undefined);
    })();
    entry.revalidating = run.finally(() => {
      entry.revalidating = undefined;
    });
    await entry.revalidating;
  };

  return { closeEntry, revalidateEntry, scheduleClose };
}

export function createConnectionContext(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  sessionId?: string;
}): McpConnectionContext {
  const mcpIsolation = input.config.isolation === "workspace" ? "workspace" : "session";
  const workspaceKey = resolveWorkspaceKey(input.connectOptions);
  return {
    mcpConnectionId: randomUUID(),
    mcpIsolation,
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(mcpIsolation === "session" && input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

function resolveWorkspaceKey(connectOptions: McpConnectOptions): string | undefined {
  return (
    connectOptions.workspaceIdentity?.trim() || connectOptions.workingDirectory?.trim() || undefined
  );
}

export function connectionKey(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  leaseId: string;
  serverName: string;
}): string {
  // 默认 session isolation；只有明确声明 workspace 的无状态 server 才允许跨 session 复用。
  const scope =
    input.config.isolation === "workspace"
      ? (resolveWorkspaceKey(input.connectOptions) ?? "")
      : input.leaseId;
  return [input.serverName, scope, stableStringify(input.config)].join("\u0000");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
