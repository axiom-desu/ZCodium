import type { McpCallToolOptions, McpCallToolRequest, McpToolCallResult } from "@zcode/contracts";
import { DEFAULT_MCP_TIMEOUT_MS, type McpClient, type McpServerRecord } from "./adapter-types.js";
import { appConnectionSnapshot } from "./connection-registry.js";
import {
  recoverToolCallAuthorization,
  reconnectForCall,
  resolveConnectedRecord,
  type McpRecoveryHost,
} from "./connection-recovery.js";
import { classifyInteractiveAuthorizationTrigger } from "./oauth-errors.js";
import { callToolOnClient } from "./tool-call.js";
import { createMcpDeadline, remainingMcpDeadlineMs, waitWithinMcpDeadline } from "./timeout.js";

export async function callTool(
  host: McpRecoveryHost,
  request: McpCallToolRequest,
  options: McpCallToolOptions = {},
): Promise<McpToolCallResult> {
  const timeoutMs =
    options.timeoutMs ??
    host.records.get(request.serverName)?.config.timeoutMs ??
    DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
  let record: McpServerRecord & { client: McpClient };
  if (options.appConnection) {
    const snapshot = appConnectionSnapshot(host, request.serverName);
    const current = host.records.get(request.serverName);
    if (
      !snapshot ||
      snapshot.identity !== options.appConnection.identity ||
      snapshot.generation !== options.appConnection.generation ||
      !current?.client
    )
      throw new Error("MCP App connection changed");
    options.signal?.throwIfAborted();
    record = current as McpServerRecord & { client: McpClient };
  } else {
    record = await resolveConnectedRecord(
      host,
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
  }

  try {
    return await callToolOnClient(
      host,
      record.client,
      request,
      remainingMcpDeadlineMs(deadline, timeoutMessage),
      options.signal,
      options.onProgress,
    );
  } catch (error) {
    if (options.appConnection) throw error;
    // 连接建立后 token 过期、被撤销或 scope 不足时，
    // 过去这些认证错误原样冒泡，用户看到裸错误且永远不会自愈——OAuth 自愈只存在于
    // startup connect 路径。现在运行期与建连期共用同一套 Phase 2 → Phase 1 编排。
    const trigger = classifyInteractiveAuthorizationTrigger(error);
    if (trigger && record.config.type !== "stdio") {
      return await recoverToolCallAuthorization(host, {
        error,
        record,
        request,
        deadline,
        timeoutMessage,
        trigger,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    }
    // 防 onclose 尚未派发的竞态：SDK 在 transport 已断时抛裸 "Not connected"。
    // 只对这一种确定的断连错误重连重试一次，其余错误原样冒泡。
    if (!(error instanceof Error) || error.message !== "Not connected") throw error;
    try {
      await waitWithinMcpDeadline(
        reconnectForCall(host, request.serverName, record.config),
        deadline,
        timeoutMessage,
        options.signal,
      );
    } catch (reconnectError) {
      host.logger?.warn("MCP server reconnect failed", {
        error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
        event: "mcp.server.reconnect.failed",
        mcpServerName: request.serverName,
        status: "failed",
      });
      throw error;
    }
    const revived = host.records.get(request.serverName);
    if (!revived?.client || revived.status.status !== "connected") throw error;
    return await callToolOnClient(
      host,
      revived.client,
      request,
      remainingMcpDeadlineMs(deadline, timeoutMessage),
      options.signal,
      options.onProgress,
    );
  }
}
