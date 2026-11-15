import type { McpServerConfig } from "./mcp.js";

export type McpSyncImportStatus = "synced" | "skipped" | "failed";
export type McpSyncSource = "zcode" | "agents";

export interface McpSyncCandidate {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

export interface McpSyncCandidateListResult {
  candidates: McpSyncCandidate[];
  localHomeDir: string;
}

export interface McpSyncRemoteStatus {
  name: string;
  exists: boolean;
  path?: string;
}

export interface McpSyncRemoteStatusResult {
  statuses: McpSyncRemoteStatus[];
  remoteHomeDir: string;
}

export interface McpSyncExportedServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

export interface McpSyncExportResult {
  servers: McpSyncExportedServer[];
  localHomeDir: string;
}

export interface McpSyncImportResultItem {
  name: string;
  status: McpSyncImportStatus;
  path?: string;
  error?: string;
}

export interface McpSyncImportResult {
  results: McpSyncImportResultItem[];
}

/** 数据同步：MCP export 的结果，也是 import 的输入。目标端按这里的来源路径做改写。 */
export interface McpDataSyncPayload {
  sourceHomeDir: string;
  /** 只有带 workspace 上下文的入口才传；两者都有时才做 workspace 改写。 */
  sourceWorkspacePath?: string;
  targetWorkspacePath?: string;
  items: Array<{
    key: string;
    /** 原大小写的 server name；新建时按它写入。 */
    name: string;
    config: McpServerConfig;
    enabled: boolean;
  }>;
}
