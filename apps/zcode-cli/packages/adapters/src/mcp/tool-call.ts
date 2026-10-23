import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpContentBlock,
  McpElicitationTrace,
  McpToolCallResult,
} from "@zcode/contracts";
import { isRecord, mcpRequestMeta } from "./protocol.js";
import type { McpClient } from "./adapter-types.js";

export interface McpToolCallHost {
  readonly activeCallTraces: Map<string, McpElicitationTrace>;
  readonly logger?: Logger;
}

/** 调用期间登记 trace，server 在这段时间发起的 elicitation 才能归属到会话 / 工具行。 */
export async function callToolOnClient(
  host: McpToolCallHost,
  client: McpClient,
  request: McpCallToolRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress?: McpCallToolOptions["onProgress"],
): Promise<McpToolCallResult> {
  host.activeCallTraces.set(request.serverName, {
    ...(request.trace?.sessionId ? { sessionId: String(request.trace.sessionId) } : {}),
    ...(request.trace?.turnId ? { turnId: String(request.trace.turnId) } : {}),
    ...(request.trace?.traceId ? { traceId: String(request.trace.traceId) } : {}),
  });
  try {
    return await callToolOnClientInner(host, client, request, timeoutMs, signal, onProgress);
  } finally {
    host.activeCallTraces.delete(request.serverName);
  }
}

async function callToolOnClientInner(
  host: McpToolCallHost,
  client: McpClient,
  request: McpCallToolRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress?: McpCallToolOptions["onProgress"],
): Promise<McpToolCallResult> {
  // 工具调用此前完全无日志：超时时既看不到预算是多少，也无法区分"服务端慢"与
  // "客户端预算太小"。这里记录预算与耗时，但只记参数的 key（值可能是用户输入）。
  const logBase = {
    event: "mcp.tool.call",
    mcpServerName: request.serverName,
    mcpToolName: request.toolName,
    module: "adapters.mcp",
    timeoutMs,
  };
  const argumentKeys = Object.keys(request.arguments ?? {}).sort();
  host.logger?.debug("MCP tool call started", {
    ...logBase,
    argumentKeys,
    status: "started",
  });

  const startedAt = Date.now();
  try {
    const result = await client.callTool(
      {
        name: request.toolName,
        arguments: request.arguments ?? {},
        ...(request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath
          ? { _meta: mcpRequestMeta(request) }
          : {}),
      },
      {
        signal,
        timeout: timeoutMs,
        // 进度通知重置超时（A8）：长任务只要持续上报就不会被 timeoutMs 打断；总时长由工具级 _meta.timeoutMs 约束。
        resetTimeoutOnProgress: true,
        ...(onProgress
          ? {
              onprogress: (notification: { progress: number; total?: number; message?: string }) =>
                onProgress({
                  progress: notification.progress,
                  ...(notification.total !== undefined ? { total: notification.total } : {}),
                  ...(notification.message !== undefined ? { message: notification.message } : {}),
                }),
            }
          : {}),
      },
    );

    const durationMs = Date.now() - startedAt;
    const isError = typeof result.isError === "boolean" ? result.isError : false;
    // 官方 MCP 的 in-band 失败（配额耗尽、无套餐）是 HTTP 200 + isError，wrapper 那条
    // 非 2xx warn 覆盖不到；request id 也只有 wrapper 能看到，所以在这里按 span 取回。
    const outcome = {
      ...logBase,
      contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
      durationMs,
      hasStructuredContent: result.structuredContent !== undefined,
      // 业务级失败（isError）与传输级失败不同，必须能分开统计。
      isError,
    };
    if (isError) {
      // 之前 in-band 失败只有这条 debug，而生产 logger 最低级别是 Info——等于配额耗尽
      // 这类失败在生产日志里完全不可见。
      host.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
    } else {
      host.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
    }

    const meta = isRecord(result._meta) ? result._meta : undefined;
    return {
      content: Array.isArray(result.content)
        ? (result.content as McpContentBlock[])
        : [{ type: "text", text: "" }],
      structuredContent: result.structuredContent,
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
      _meta: meta,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    // 判定是否为超时：SDK 超时会抛 MCP error code -32001 (RequestTimeout)，
    // 底层 fetch abort 抛 AbortError。两者都要能一眼认出，否则只能看到裸 message。
    const timedOut =
      /timed?\s*out|timeout/i.test(message) ||
      (error instanceof Error && error.name === "AbortError");
    host.logger?.warn("MCP tool call failed", {
      ...logBase,
      argumentKeys,
      durationMs,
      error: message,
      errorName: error instanceof Error ? error.name : "unknown",
      status: "failed",
      timedOut,
      // 耗时贴着预算 ⇒ 是我们掐断的；远小于预算 ⇒ 是对端或网络断的。
      ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
    });
    throw error;
  }
}
