import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";
import type { McpProcessTracker } from "./process-tracker.js";
import {
  connectionKey,
  createConnectionContext,
  createPoolEntryLifecycle,
  type CreateMcpAdapterForPoolInput,
  type PoolEntry,
} from "./pool-entry.js";

const DEFAULT_IDLE_GRACE_MS = 30_000;

export interface McpConnectionPoolOptions {
  createAdapter(input: CreateMcpAdapterForPoolInput): McpPort;
  idleGraceMs?: number;
  logger?: Logger;
  processTracker?: McpProcessTracker;
}

export interface McpConnectionPool {
  acquireLease(options?: { leaseId?: string; sessionId?: string }): McpPort;
  close(): Promise<void>;
  stats(): { activeConnections: number; pendingCloseConnections: number };
}

export function createMcpConnectionPool(options: McpConnectionPoolOptions): McpConnectionPool {
  const entries = new Map<string, PoolEntry>();
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const logger = options.logger?.child({ module: "adapters.mcp.pool" });
  let closed = false;
  let leaseSequence = 0;
  const { closeEntry, revalidateEntry, scheduleClose } = createPoolEntryLifecycle({
    entries,
    idleGraceMs,
    ...(logger ? { logger } : {}),
    ...(options.processTracker ? { processTracker: options.processTracker } : {}),
  });

  const acquireLease = (leaseOptions: { leaseId?: string; sessionId?: string } = {}): McpPort => {
    if (closed) throw new Error("MCP connection pool is closed");
    const leaseId = `${++leaseSequence}:${leaseOptions.leaseId ?? "lease"}`;
    const sessionId = leaseOptions.sessionId?.trim() || undefined;
    const leased = new Map<string, string>();
    const configuredServers = new Map<string, McpServerConfig>();
    const appListeners = new Map<string, Set<{ listener: () => void; off: () => void }>>();
    const invalidateApps = (serverName: string) => {
      const watchers = appListeners.get(serverName);
      appListeners.delete(serverName);
      for (const watcher of watchers ?? []) {
        watcher.off();
        watcher.listener();
      }
    };
    let leaseClosed = false;
    let sessionStartupReported = false;

    const requireEntry = (serverName: string): PoolEntry => {
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    const release = (serverName: string): void => {
      const key = leased.get(serverName);
      if (!key) return;
      leased.delete(serverName);
      invalidateApps(serverName);
      const entry = entries.get(key);
      if (!entry) return;
      if (!entry.refs.delete(leaseId)) return;
      options.processTracker?.releaseOwner({
        connectionId: entry.connectionContext.mcpConnectionId,
        ownerId: leaseId,
      });
      logger?.info("MCP connection lease released", {
        ...entry.connectionContext,
        event: "mcp.pool.lease.released",
        mcpLeaseId: leaseId,
        mcpServerName: serverName,
        refCount: entry.refs.size,
        ...(sessionId ? { sessionId } : {}),
      });
      if (entry.refs.size === 0) scheduleClose(entry);
    };

    const acquire = async (
      serverName: string,
      config: McpServerConfig,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpServerStatus> => {
      const key = connectionKey({
        config,
        connectOptions,
        leaseId,
        serverName,
      });
      const previousKey = leased.get(serverName);
      let entry = entries.get(key);
      let ownerAdded = false;
      if (entry) {
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.closeTimer = undefined;
        const previousRefCount = entry.refs.size;
        entry.refs.add(leaseId);
        ownerAdded = entry.refs.size !== previousRefCount;
        if (connectOptions.revalidate) {
          await revalidateEntry(entry, config, connectOptions);
        }
      } else {
        // 过去 pool、adapter 和 stdio PID 的日志彼此没有稳定关联键，无法从一个
        // session 追到实际 MCP 子进程。连接上下文在 entry 创建时固定，后续 lease 共用同一 ID。
        const connectionContext = createConnectionContext({
          config,
          connectOptions,
          sessionId,
        });
        options.processTracker?.registerConnection({
          connectionId: connectionContext.mcpConnectionId,
          isolation: connectionContext.mcpIsolation,
          serverName,
          ...(config.source ? { source: config.source.kind } : {}),
        });
        const adapter = options.createAdapter({
          connectionContext,
          config,
          serverName,
          workingDirectory: connectOptions.workingDirectory,
        });
        entry = {
          adapter,
          connectionContext,
          connecting: adapter.connectServer(serverName, config, connectOptions),
          key,
          refs: new Set([leaseId]),
          serverName,
        };
        entries.set(key, entry);
        ownerAdded = true;
        logger?.info("MCP pooled connection created", {
          ...connectionContext,
          event: "mcp.pool.connection.created",
          mcpServerName: serverName,
          transport: config.type,
        });
      }
      if (previousKey && previousKey !== key) {
        invalidateApps(serverName);
        const previous = entries.get(previousKey);
        if (previous) {
          if (previous.refs.delete(leaseId)) {
            options.processTracker?.releaseOwner({
              connectionId: previous.connectionContext.mcpConnectionId,
              ownerId: leaseId,
            });
            logger?.info("MCP connection lease released", {
              ...previous.connectionContext,
              event: "mcp.pool.lease.released",
              mcpLeaseId: leaseId,
              mcpServerName: serverName,
              refCount: previous.refs.size,
              ...(sessionId ? { sessionId } : {}),
            });
            if (previous.refs.size === 0) scheduleClose(previous);
          }
        }
      }
      leased.set(serverName, key);
      if (ownerAdded) {
        options.processTracker?.acquireOwner({
          connectionId: entry.connectionContext.mcpConnectionId,
          ownerId: leaseId,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      if (previousKey !== key) {
        // workspace 隔离连接会被多个 session 共享，不能把首个 session 记成唯一 owner；
        // 单独记录 lease 生命周期才能准确表达多对一关系。
        logger?.info("MCP connection lease acquired", {
          ...entry.connectionContext,
          event: "mcp.pool.lease.acquired",
          mcpLeaseId: leaseId,
          mcpServerName: serverName,
          refCount: entry.refs.size,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      return await entry.connecting;
    };

    const snapshot = async (): Promise<McpConnectionSnapshot> => {
      const statuses: Record<string, McpServerStatus> = {};
      const tools: McpToolDescriptor[] = [];
      for (const [serverName, key] of leased) {
        const entry = entries.get(key);
        if (!entry) continue;
        const status = (await entry.adapter.status())[serverName];
        if (status) statuses[serverName] = status;
        tools.push(...(await entry.adapter.listTools()));
      }
      if (sessionId && !sessionStartupReported) {
        sessionStartupReported = true;
        const enabledServers = [...configuredServers].filter(
          ([, config]) => config.enabled !== false,
        );
        const connectedCount = enabledServers.filter(
          ([serverName]) => statuses[serverName]?.status === "connected",
        ).length;
        options.processTracker?.recordSessionStartup({
          configuredCount: enabledServers.length,
          connectedCount,
          failedCount: enabledServers.length - connectedCount,
          processCount: enabledServers.filter(
            ([serverName, config]) =>
              config.type === "stdio" && statuses[serverName]?.status === "connected",
          ).length,
          sessionId,
        });
      }
      return { statuses, tools };
    };

    return {
      appConnectionSnapshot(serverName) {
        const key = leased.get(serverName);
        return key ? (entries.get(key)?.adapter.appConnectionSnapshot?.(serverName) ?? null) : null;
      },
      onAppConnectionInvalidated(serverName, listener) {
        const entry = requireEntry(serverName);
        const watchers = appListeners.get(serverName) ?? new Set();
        const watcher = {
          listener,
          off: entry.adapter.onAppConnectionInvalidated?.(serverName, listener) ?? (() => {}),
        };
        watchers.add(watcher);
        appListeners.set(serverName, watchers);
        return () => {
          watcher.off();
          watchers.delete(watcher);
          if (!watchers.size) appListeners.delete(serverName);
        };
      },
      async callTool(
        request: McpCallToolRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpToolCallResult> {
        return await requireEntry(request.serverName).adapter.callTool(request, callOptions);
      },
      async readResource(
        request: McpReadResourceRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpReadResourceResult> {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.readResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.readResource(request, callOptions);
      },
      // 资源列表与订阅经同一 entry 的 adapter；登记表在 adapter（连接层）里，多 session 共享。
      async listResources(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResources) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResources(request, callOptions);
      },
      async listResourceTemplates(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResourceTemplates) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResourceTemplates(request, callOptions);
      },
      async subscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.subscribeResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        await adapter.subscribeResource(request, callOptions);
      },
      async unsubscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.unsubscribeResource) return;
        await adapter.unsubscribeResource(request, callOptions);
      },
      async unsubscribeResourcesBySubscriber(prefix) {
        let released = 0;
        const seen = new Set<string>();
        for (const key of leased.values()) {
          if (seen.has(key)) continue;
          seen.add(key);
          const adapter = entries.get(key)?.adapter;
          if (adapter?.unsubscribeResourcesBySubscriber) {
            released += await adapter.unsubscribeResourcesBySubscriber(prefix);
          }
        }
        return released;
      },
      async close(): Promise<void> {
        if (leaseClosed) return;
        leaseClosed = true;
        for (const serverName of Array.from(leased.keys())) release(serverName);
      },
      async connectConfiguredServers(
        servers: Record<string, McpServerConfig>,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpConnectionSnapshot> {
        configuredServers.clear();
        for (const [serverName, config] of Object.entries(servers)) {
          configuredServers.set(serverName, config);
        }
        const configuredNames = new Set(Object.keys(servers));
        for (const serverName of Array.from(leased.keys())) {
          if (!configuredNames.has(serverName)) release(serverName);
        }
        await Promise.all(
          Object.entries(servers).map(([serverName, config]) =>
            acquire(serverName, config, connectOptions),
          ),
        );
        return await snapshot();
      },
      async connectServer(
        serverName: string,
        config: McpServerConfig,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpServerStatus> {
        return await acquire(serverName, config, connectOptions);
      },
      async disconnectServer(serverName: string): Promise<McpServerStatus | undefined> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        const status = entry ? (await entry.adapter.status())[serverName] : undefined;
        release(serverName);
        return status
          ? {
              ...status,
              status: "disconnected",
              toolCount: 0,
              updatedAt: new Date().toISOString(),
            }
          : undefined;
      },
      async listTools(): Promise<McpToolDescriptor[]> {
        return (await snapshot()).tools;
      },
      toolListRevision(): number {
        let revision = 0;
        for (const key of new Set(leased.values())) {
          revision += entries.get(key)?.adapter.toolListRevision?.() ?? 0;
        }
        return revision;
      },
      async pingServer(serverName: string, pingOptions?: { timeoutMs?: number }): Promise<boolean> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        if (!entry) return false;
        return (await entry.adapter.pingServer?.(serverName, pingOptions)) ?? true;
      },
      async status(): Promise<Record<string, McpServerStatus>> {
        return (await snapshot()).statuses;
      },
    };
  };

  return {
    acquireLease,
    async close(): Promise<void> {
      closed = true;
      const pending = [...entries.values()];
      entries.clear();
      await Promise.all(pending.map(closeEntry));
    },
    stats() {
      return {
        activeConnections: entries.size,
        pendingCloseConnections: [...entries.values()].filter((entry) => entry.refs.size === 0)
          .length,
      };
    },
  };
}
