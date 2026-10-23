import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpElicitationPort,
  McpNotificationPort,
  McpOAuthConfig,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import type { NetworkEgressEnvPolicy } from "./network.js";
import type { McpConnectionContext } from "./pool-entry.js";
import type { McpOAuthRuntimeOptions } from "./oauth.js";
import type { McpProcessTracker } from "./process-tracker.js";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
// 存活探测只允许占用很短的时间：它挂在设置页刷新的同步路径上，超时即判死并触发重连。
export const MCP_PING_TIMEOUT_MS = 5_000;
export const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
export const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  processTracker?: McpProcessTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  workingDirectory?: string;
  /** 有此端口才向 server 宣告 elicitation 能力；缺省时 server 的 elicitation/create 收到 method not found。 */
  elicitation?: McpElicitationPort;
  /** server → client 通知（资源更新 / 列表变化 / 工具列表变化 / 日志）的出口；缺省只记 debug。 */
  notifications?: McpNotificationPort;
}

export type McpClient = Client;
export type McpTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;
export type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/** 订阅的 server → client 通知方法名（MCP 规范）。 */
export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = "notifications/tools/list_changed";
export const MCP_NOTIFICATION_RESOURCES_UPDATED = "notifications/resources/updated";
export const MCP_NOTIFICATION_RESOURCES_LIST_CHANGED = "notifications/resources/list_changed";
export const MCP_NOTIFICATION_MESSAGE = "notifications/message";

export interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  /** 收到 tools/list_changed 后置位，下一次 listTools 重拉。 */
  toolsStale?: boolean;
  transport?: McpTransport;
}
