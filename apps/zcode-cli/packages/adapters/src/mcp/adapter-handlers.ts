import type {
  Logger,
  McpElicitationPort,
  McpElicitationTrace,
  McpNotificationPort,
} from "@zcode/contracts";
import { isSupportedElicitationMode } from "./protocol.js";
import {
  MCP_NOTIFICATION_MESSAGE,
  MCP_NOTIFICATION_RESOURCES_LIST_CHANGED,
  MCP_NOTIFICATION_RESOURCES_UPDATED,
  MCP_NOTIFICATION_TOOLS_LIST_CHANGED,
  type McpClient,
  type McpServerRecord,
} from "./adapter-types.js";
import type { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";

export interface McpHandlerHost {
  readonly records: Map<string, McpServerRecord>;
  readonly resourceSubscriptions: McpResourceSubscriptionRegistry;
  readonly activeCallTraces: Map<string, McpElicitationTrace>;
  readonly elicitation?: McpElicitationPort;
  readonly logger?: Logger;
  readonly notifications?: McpNotificationPort;
  onToolListChanged(serverName: string): void;
}

/**
 * server 主动通知。订阅类通知附上当前登记的 subscriberKey（宿主据此按会话拆分）；
 * tools/list_changed 只标记 stale，下一次 listTools 再拉；没有端口时 SDK 默认丢弃。
 */
export function installNotificationHandlers(
  host: McpHandlerHost,
  client: McpClient,
  serverName: string,
): void {
  const setNotificationHandler = (client as unknown as { setNotificationHandler?: unknown })
    .setNotificationHandler;
  if (typeof setNotificationHandler !== "function") return;
  // SDK 2.x：第一个参数是通知方法名（spec 方法直接用字符串），schema 是可选的第二个参数。
  const typed = client as unknown as {
    setNotificationHandler(method: string, handler: (notification: unknown) => void): void;
  };
  typed.setNotificationHandler(MCP_NOTIFICATION_TOOLS_LIST_CHANGED, () => {
    const record = host.records.get(serverName);
    if (record) record.toolsStale = true;
    host.onToolListChanged(serverName);
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_UPDATED, (notification) => {
    const uri = (notification as { params?: { uri?: unknown } }).params?.uri;
    if (typeof uri !== "string") return;
    host.notifications?.onNotification({
      kind: "resourceUpdated",
      serverName,
      uri,
      subscribers: host.resourceSubscriptions.subscribers(serverName, uri),
    });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_LIST_CHANGED, () => {
    host.notifications?.onNotification({
      kind: "resourceListChanged",
      serverName,
      subscribers: host.resourceSubscriptions.allSubscribers(serverName),
    });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_MESSAGE, (notification) => {
    const params = (notification as { params?: Record<string, unknown> }).params ?? {};
    host.notifications?.onNotification({
      kind: "loggingMessage",
      serverName,
      level: typeof params.level === "string" ? params.level : "info",
      ...(typeof params.logger === "string" ? { logger: params.logger } : {}),
      data: params.data,
    });
  });
}

/** server 主动 elicitation/create：归属到该 server 当前工具调用的会话，交给宿主提问端口。 */
export function installElicitationHandler(
  host: McpHandlerHost,
  client: McpClient,
  serverName: string,
): void {
  const port = host.elicitation;
  const setRequestHandler = (client as unknown as { setRequestHandler?: unknown })
    .setRequestHandler;
  if (!port || typeof setRequestHandler !== "function") return;
  (
    client as unknown as {
      setRequestHandler(
        method: "elicitation/create",
        handler: (request: {
          params: { message: string; requestedSchema?: unknown };
        }) => Promise<unknown>,
      ): void;
    }
  ).setRequestHandler("elicitation/create", async (request) => {
    // 接受缺省 / "form" / 兼容接口的 "openai/form" / "openaiForm"；url 等其它模式 decline。
    const mode = (request.params as { mode?: unknown }).mode;
    if (!isSupportedElicitationMode(mode)) {
      host.logger?.warn("MCP elicitation mode not supported, declining", {
        event: "mcp.elicitation.unsupported_mode",
        mcpServerName: serverName,
        mode: String(mode),
      });
      return { action: "decline" };
    }
    const trace = host.activeCallTraces.get(serverName);
    const result = await port.requestElicitation({
      serverName,
      message: request.params.message,
      requestedSchema: request.params.requestedSchema,
      ...(trace ? { trace } : {}),
    });
    return result.action === "accept"
      ? { action: "accept", content: result.content ?? {} }
      : { action: result.action };
  });
}
