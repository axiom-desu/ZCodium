import type { Logger } from "@zcode/contracts";
import type { McpProcessTracker } from "./process-tracker.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpConnectionContext } from "./pool-entry.js";
import { getStdioTransportPid } from "./protocol.js";
import type { McpClient, McpServerRecord, McpTransport } from "./adapter-types.js";

export interface McpTeardownHost {
  readonly records: Map<string, McpServerRecord>;
  readonly connectionContext?: McpConnectionContext;
  readonly logger?: Logger;
  readonly processTracker?: McpProcessTracker;
}

export async function closeRecord(host: McpTeardownHost, name: string): Promise<void> {
  const record = host.records.get(name);
  if (!record) return;
  record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
  if (!record.client && !record.transport) return;
  await closeClientAndTransport(host, name, record.client, record.transport);
}

export async function closeClientAndTransport(
  host: McpTeardownHost,
  name: string,
  client?: McpClient,
  transport?: McpTransport,
): Promise<void> {
  const startedAt = Date.now();
  const mcpTransportPid = getStdioTransportPid(transport);
  // 主动关闭前先摘掉 connection_lost 监听，避免正常回收被误报为意外断连。
  if (client) client.onclose = undefined;
  // MCP SDK close 只保证直接 stdio 子进程退出，npx/npm wrapper 拉起的 MCP server
  // 或 chrome-devtools-mcp watchdog 可能残留；这里先按进程树显式回收，再走 SDK close 清理协议状态。
  await terminateStdioProcessTree(host, name, transport);

  try {
    await client?.close();
  } catch (error) {
    host.logger?.debug("MCP client close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.client.close.failed",
      mcpServerName: name,
    });
  }

  try {
    await transport?.close();
  } catch (error) {
    host.logger?.debug("MCP transport close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.transport.close.failed",
      mcpServerName: name,
    });
  }
  if (
    host.connectionContext &&
    transport instanceof ProcessTreeStdioClientTransport &&
    !transport.processAlive
  ) {
    host.processTracker?.recordProcessClosed({
      connectionId: host.connectionContext.mcpConnectionId,
    });
  }
  host.logger?.info("MCP server closed", {
    ...host.connectionContext,
    durationMs: Date.now() - startedAt,
    event: "mcp.server.closed",
    mcpServerName: name,
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "completed",
  });
}

async function terminateStdioProcessTree(
  host: McpTeardownHost,
  name: string,
  transport?: McpTransport,
): Promise<void> {
  const pid = getStdioTransportPid(transport);
  if (pid == null) return;

  try {
    await terminateMcpStdioProcessTree(pid);
  } catch (error) {
    host.logger?.warn("MCP stdio process tree cleanup failed", {
      ...host.connectionContext,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.stdio.process_tree_cleanup.failed",
      mcpServerName: name,
      mcpTransportPid: pid,
      pid,
      status: "failed",
    });
  }
}
