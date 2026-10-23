import type {
  Logger,
  McpCallToolOptions,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpResourceSubscriptionRequest,
} from "@zcode/contracts";
import { McpResourceSubscribeUnsupportedError } from "@zcode/contracts";
import { pickResourceDescriptor, isRecord } from "./protocol.js";
import { remainingMcpDeadlineMs, createMcpDeadline, type McpDeadline } from "./timeout.js";
import type { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import { DEFAULT_MCP_TIMEOUT_MS, type McpClient, type McpServerRecord } from "./adapter-types.js";

export interface McpResourceHost {
  readonly records: Map<string, McpServerRecord>;
  readonly resourceSubscriptions: McpResourceSubscriptionRegistry;
  readonly logger?: Logger;
  resolveConnectedRecord(
    serverName: string,
    deadline: McpDeadline,
    timeoutMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<McpServerRecord & { client: McpClient }>;
  resolveForResourceRequest(
    serverName: string,
    operation: string,
    options: McpCallToolOptions,
  ): Promise<{
    record: McpServerRecord & { client: McpClient };
    deadline: McpDeadline;
    timeoutMessage: string;
  }>;
}

/** `resources/list`，分页游标透传。 */
export async function listResources(
  host: McpResourceHost,
  request: McpListResourcesRequest,
  options: McpCallToolOptions = {},
): Promise<McpListResourcesResult> {
  const { record, deadline, timeoutMessage } = await host.resolveForResourceRequest(
    request.serverName,
    "resources/list",
    options,
  );
  const result = await record.client.listResources(
    request.cursor ? { cursor: request.cursor } : {},
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    resources: (result.resources ?? []).map((resource) => {
      const { uri, ...rest } = pickResourceDescriptor(resource);
      return { uri: uri ?? "", ...rest };
    }),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function listResourceTemplates(
  host: McpResourceHost,
  request: McpListResourcesRequest,
  options: McpCallToolOptions = {},
): Promise<McpListResourceTemplatesResult> {
  const { record, deadline, timeoutMessage } = await host.resolveForResourceRequest(
    request.serverName,
    "resources/templates/list",
    options,
  );
  const result = await record.client.listResourceTemplates(
    request.cursor ? { cursor: request.cursor } : {},
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    resourceTemplates: (result.resourceTemplates ?? []).map((template) => {
      const item = template as Record<string, unknown>;
      return {
        uriTemplate: typeof item.uriTemplate === "string" ? item.uriTemplate : "",
        ...pickResourceDescriptor(item, false),
      };
    }),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

/**
 * 按 (serverName, uri) 计数的订阅。同一连接被多个 session 共享时只向 server 订阅一次；
 * server 没声明 resources.subscribe 能力 → McpResourceSubscribeUnsupportedError。
 */
export async function subscribeResource(
  host: McpResourceHost,
  request: McpResourceSubscriptionRequest,
  options: McpCallToolOptions = {},
): Promise<void> {
  const { record, deadline, timeoutMessage } = await host.resolveForResourceRequest(
    request.serverName,
    "resources/subscribe",
    options,
  );
  if (!record.client.getServerCapabilities()?.resources?.subscribe) {
    throw new McpResourceSubscribeUnsupportedError(request.serverName);
  }
  const { first } = host.resourceSubscriptions.add(
    request.serverName,
    request.uri,
    request.subscriberKey,
  );
  if (!first) return;
  try {
    await record.client.subscribeResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
  } catch (error) {
    host.resourceSubscriptions.remove(request.serverName, request.uri, request.subscriberKey);
    throw error;
  }
  host.logger?.info("MCP resource subscribed", {
    event: "mcp.resource.subscribe",
    mcpServerName: request.serverName,
    uri: request.uri,
    status: "completed",
  });
}

export async function unsubscribeResource(
  host: McpResourceHost,
  request: McpResourceSubscriptionRequest,
  options: McpCallToolOptions = {},
): Promise<void> {
  const removed = host.resourceSubscriptions.remove(
    request.serverName,
    request.uri,
    request.subscriberKey,
  );
  if (!removed?.last) return;
  await unsubscribeOnServer(host, request.serverName, request.uri, options);
}

export async function unsubscribeResourcesBySubscriber(
  host: McpResourceHost,
  subscriberKeyPrefix: string,
): Promise<number> {
  const released = host.resourceSubscriptions.removeByPrefix(subscriberKeyPrefix);
  for (const { serverName, uri } of released) {
    await unsubscribeOnServer(host, serverName, uri, {});
  }
  return released.length;
}

/** 登记表快照（测试 / 诊断）：serverName → uri → 订阅者数。 */
export function resourceSubscriptionCounts(
  host: McpResourceHost,
): Record<string, Record<string, number>> {
  return host.resourceSubscriptions.counts();
}

async function unsubscribeOnServer(
  host: McpResourceHost,
  serverName: string,
  uri: string,
  options: McpCallToolOptions,
): Promise<void> {
  const record = host.records.get(serverName);
  if (!record?.client || record.status.status !== "connected") return;
  try {
    await record.client.unsubscribeResource({ uri }, { signal: options.signal });
    host.logger?.info("MCP resource unsubscribed", {
      event: "mcp.resource.unsubscribe",
      mcpServerName: serverName,
      uri,
      status: "completed",
    });
  } catch (error) {
    // 退订失败只记日志：登记表已清，server 多发的通知因没有订阅者会被丢弃。
    host.logger?.warn("MCP resource unsubscribe failed", {
      event: "mcp.resource.unsubscribe",
      mcpServerName: serverName,
      uri,
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
  }
}

/** 断连重连后按登记表重放 subscribe（A3）；单条失败不影响其它。 */
export async function replayResourceSubscriptions(
  host: McpResourceHost,
  serverName: string,
  client: McpClient,
): Promise<void> {
  const uris = host.resourceSubscriptions.uris(serverName);
  if (uris.length === 0) return;
  if (!client.getServerCapabilities()?.resources?.subscribe) return;
  for (const uri of uris) {
    try {
      await client.subscribeResource({ uri });
    } catch (error) {
      host.logger?.warn("MCP resource subscription replay failed", {
        event: "mcp.resource.subscribe",
        mcpServerName: serverName,
        uri,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  }
  host.logger?.info("MCP resource subscriptions replayed after reconnect", {
    event: "mcp.resource.subscribe.replayed",
    mcpServerName: serverName,
    uriCount: uris.length,
  });
}

/**
 * 插件 UI 的 `ui://` 资源读取。与 callTool 共用连接等待 / 断连重连骨架（resolveConnectedRecord），
 * 保证走同一条连接与 OAuth 恢复路径；不做 tool 级 OAuth 二次恢复——资源读取失败直接冒泡，
 * 由 UI 回退到普通卡片。
 */
export async function readResource(
  host: McpResourceHost,
  request: McpReadResourceRequest,
  options: McpCallToolOptions = {},
): Promise<McpReadResourceResult> {
  const timeoutMs =
    options.timeoutMs ??
    host.records.get(request.serverName)?.config.timeoutMs ??
    DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP resource ${request.serverName} ${request.uri} timed out after ${timeoutMs}ms`;
  const record = await host.resolveConnectedRecord(
    request.serverName,
    deadline,
    timeoutMessage,
    options.signal,
  );
  const result = await record.client.readResource(
    { uri: request.uri },
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    contents: (result.contents ?? []).map((content) => {
      const item = content as Record<string, unknown>;
      return {
        uri: typeof item.uri === "string" ? item.uri : request.uri,
        ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
        ...(typeof item.text === "string" ? { text: item.text } : {}),
        ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
        ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
      };
    }),
  };
}

export async function resolveForResourceRequest(
  host: McpResourceHost,
  serverName: string,
  operation: string,
  options: McpCallToolOptions,
): Promise<{
  record: McpServerRecord & { client: McpClient };
  deadline: McpDeadline;
  timeoutMessage: string;
}> {
  const timeoutMs =
    options.timeoutMs ?? host.records.get(serverName)?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP ${operation} ${serverName} timed out after ${timeoutMs}ms`;
  const record = await host.resolveConnectedRecord(
    serverName,
    deadline,
    timeoutMessage,
    options.signal,
  );
  return { record, deadline, timeoutMessage };
}
