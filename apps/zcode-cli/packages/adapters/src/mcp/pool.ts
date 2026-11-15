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
import { createLeaseCancellation } from "./pool-lease-cancel.js";
import { createPoolSnapshotReader } from "./pool-snapshot.js";

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
    const requireEntry = (serverName: string): PoolEntry => {
      lease.assertOpen();
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    const release = (serverName: string, immediate = false): Promise<void> | undefined => {
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
      if (entry.refs.size === 0) {
        // session 隔离的 entry 只服务本 lease，lease 关闭即关连接（不再等 idle grace）；
        // workspace 隔离的连接仍可能被其它 lease 持有，统一走 idle 调度。
        if (immediate && entry.connectionContext.mcpIsolation === "session") {
          return closeEntry(entry);
        }
        scheduleClose(entry);
      }
    };
    // lease 级取消域只合并信号，不拥有连接：entry 的 controller 在 pool-entry 生命周期里。
    const lease = createLeaseCancellation({
      isPoolClosed: () => closed,
      releaseLeases: () => [...leased.keys()].map((serverName) => release(serverName, true)),
    });
    const callOptionsWithSignal = (
      entry: PoolEntry,
      callOptions?: McpCallToolOptions,
    ): McpCallToolOptions => ({
      ...callOptions,
      signal: lease.requestSignal(entry, callOptions?.signal),
    });

    const acquire = async (
      serverName: string,
      config: McpServerConfig,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpServerStatus> => {
      lease.assertOpen();
      const signal = lease.callerSignal(connectOptions.signal);
      signal.throwIfAborted();
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
          await lease.wait(revalidateEntry(entry, config, connectOptions), signal);
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
          // 遥测词表只有 custom/plugin/builtin：workspace/user 来源在资源遥测里按 custom 归类，
          // 不新增第二套 source 词表（连接来源仍由 config.source 保持原值）。
          ...(config.source
            ? {
                source:
                  config.source.kind === "workspace" || config.source.kind === "user"
                    ? ("custom" as const)
                    : config.source.kind,
              }
            : {}),
        });
        const adapter = options.createAdapter({
          connectionContext,
          config,
          serverName,
          workingDirectory: connectOptions.workingDirectory,
        });
        // 连接归 pool，不能继承第一个 session 的关闭信号，否则会连带中止其他 lease。
        const controller = new AbortController();
        entry = {
          adapter,
          controller,
          connectionContext,
          connecting: adapter.connectServer(serverName, config, {
            ...connectOptions,
            signal: controller.signal,
          }),
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
      return await lease.wait(entry.connecting, signal);
    };

    const snapshot = createPoolSnapshotReader({
      assertOpen: lease.assertOpen,
      configuredServers,
      entries,
      leased,
      ...(options.processTracker ? { processTracker: options.processTracker } : {}),
      ...(sessionId ? { sessionId } : {}),
    });

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
        const entry = requireEntry(request.serverName);
        return await entry.adapter.callTool(request, callOptionsWithSignal(entry, callOptions));
      },
      async readResource(
        request: McpReadResourceRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpReadResourceResult> {
        const entry = requireEntry(request.serverName);
        if (!entry.adapter.readResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await entry.adapter.readResource(request, callOptionsWithSignal(entry, callOptions));
      },
      // 资源列表与订阅经同一 entry 的 adapter；登记表在 adapter（连接层）里，多 session 共享。
      async listResources(request, callOptions) {
        const entry = requireEntry(request.serverName);
        if (!entry.adapter.listResources) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await entry.adapter.listResources(request, callOptionsWithSignal(entry, callOptions));
      },
      async listResourceTemplates(request, callOptions) {
        const entry = requireEntry(request.serverName);
        if (!entry.adapter.listResourceTemplates) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await entry.adapter.listResourceTemplates(request, callOptionsWithSignal(entry, callOptions));
      },
      async subscribeResource(request, callOptions) {
        const entry = requireEntry(request.serverName);
        if (!entry.adapter.subscribeResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        await entry.adapter.subscribeResource(request, callOptionsWithSignal(entry, callOptions));
      },
      async unsubscribeResource(request, callOptions) {
        const entry = requireEntry(request.serverName);
        if (!entry.adapter.unsubscribeResource) return;
        await entry.adapter.unsubscribeResource(request, callOptionsWithSignal(entry, callOptions));
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
      close(): Promise<void> {
        return lease.close();
      },
      async connectConfiguredServers(
        servers: Record<string, McpServerConfig>,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpConnectionSnapshot> {
        lease.assertOpen();
        lease.callerSignal(connectOptions.signal).throwIfAborted();
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
        lease.callerSignal(connectOptions.signal).throwIfAborted();
        return await lease.wait(snapshot(lease.callerSignal(connectOptions.signal)));
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
