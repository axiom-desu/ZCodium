import type {
  McpConnectionSnapshot,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import type { PoolEntry } from "./pool-entry.js";
import type { McpProcessTracker } from "./process-tracker.js";

interface PoolSnapshotReaderOptions {
  assertOpen(): void;
  configuredServers: Map<string, McpServerConfig>;
  entries: Map<string, PoolEntry>;
  leased: Map<string, string>;
  processTracker?: McpProcessTracker;
  sessionId?: string;
}

/**
 * 连接池只读投影：statuses/tools 只读当前 lease 的 entry，不触发连接或重连。
 * session 启动遥测只上报一次，按本次读取的 connected 快照计算。
 */
export function createPoolSnapshotReader(
  options: PoolSnapshotReaderOptions,
): (signal?: AbortSignal) => Promise<McpConnectionSnapshot> {
  let sessionStartupReported = false;
  return async (signal) => {
    options.assertOpen();
    const statuses: Record<string, McpServerStatus> = {};
    const tools: McpToolDescriptor[] = [];
    for (const [serverName, key] of options.leased) {
      signal?.throwIfAborted();
      const entry = options.entries.get(key);
      if (!entry) continue;
      const status = (await entry.adapter.status())[serverName];
      if (status) statuses[serverName] = status;
      tools.push(...(await entry.adapter.listTools()));
    }
    options.assertOpen();
    const { sessionId, processTracker } = options;
    if (sessionId && !sessionStartupReported) {
      sessionStartupReported = true;
      const enabledServers = [...options.configuredServers].filter(
        ([, config]) => config.enabled !== false,
      );
      const connectedCount = enabledServers.filter(
        ([serverName]) => statuses[serverName]?.status === "connected",
      ).length;
      processTracker?.recordSessionStartup({
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
}
