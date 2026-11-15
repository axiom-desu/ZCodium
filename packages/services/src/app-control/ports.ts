import type { AppScope, AppSessionRef } from "@zcode/session-control/contracts";
import type { ProjectDirectories, ProjectTree } from "#src/project/contract.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";
import type { AppControlCallerConnection } from "./contract.js";

/** V4 投影里 App fork 需要的最少行事实；不把整条 rendering row 带进 App 层。 */
export interface AppControlConversationRow {
  kind: string;
  rowId: number;
  entityId?: string;
  assistantResponseId?: string;
  canFork?: boolean;
}

export interface AppControlConversationPage {
  rows: readonly AppControlConversationRow[];
  atRevision: number;
  atLogEpoch: string;
  hasMore: boolean;
}

/** `unsupported` 是旧 Agent 对 v4 forkAssistant 的明确拒绝；不是“所有 Agent 永不支持”。 */
export type AppControlForkCommandResult =
  | { status: "created"; sessionId: string }
  | { status: "rejected"; reason?: string }
  | { status: "unknown"; reason?: string }
  | { status: "unsupported"; reason?: string };

/**
 * 导航 owner 的端口。只有真正完成打开才返回 `opened`；
 * 校验会话可恢复不算导航（那只是读事实）。
 */
export interface AppControlNavigationPort {
  openSession(input: {
    session: AppSessionRef;
    uiTarget?: string;
    binding: AppControlCallerConnection & { uiTarget?: string };
  }): Promise<{ status: "opened" | "unavailable"; uiTarget?: string; reason?: string }>;
}

/** 只读发现来源：每次调用捕获，不建立连接、不创建 Agent、不保存目录。 */
export interface AppControlDiscoverySource {
  sourceServerId: string;
  scopes: readonly AppScope[];
  unavailableReason?: string;
  readTree(): Promise<ProjectTree>;
  assertCurrent(): void;
}

export interface AppControlDiscoveryFailure {
  sourceServerId: string;
  reason: string;
}

/** 本 Host 的发现批次：一次目录快照 + 同步复验。 */
export interface AppControlDiscoveryBatch {
  sources: readonly AppControlDiscoverySource[];
  prepareValidation(): Promise<() => readonly AppControlDiscoveryFailure[]>;
}

/**
 * 发现端口。本仓当前只有本机一个来源，因此实现只投影本 Host 的项目；
 * 远端来源未接线时返回 `unavailableSources`，绝不伪造空结果。
 */
export interface AppControlDiscoveryPort {
  listSources(binding: AppControlCallerConnection): Promise<AppControlDiscoveryBatch>;
}

export interface AppControlProjectPort {
  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
  }): Promise<ProjectTree>;
  readProjects(options?: {
    includeDeleted?: boolean;
  }): Promise<Array<{ id: string; hostId: string; name: string; deleted?: boolean }>>;
  prepareSession(options?: { projectId?: string; hostId?: string }): Promise<ProjectDirectories>;
  /**
   * CLI 已创建 fork 子会话后的产品归属预留；复用项目仓储的唯一 task 预占 owner。
   * 缺失时 App fork 明确 unavailable，不伪造 created。
   */
  reserveFork?(input: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    projectId: string | null;
    forkedFromTaskId: string;
  }): Promise<void>;
}

/** 会话执行 owner：真实入口仍是 task/agent 服务，App control 不持第二份执行状态。 */
export interface AppControlTaskPort {
  getTaskMeta(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ taskId: string; title: string; status?: string; updatedAt: number } | null>;
  createTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    projectId?: string | null;
    additionalDirectories?: string[];
    deferPersistenceUntilFirstPrompt?: boolean;
    v4Create?: boolean;
  }): Promise<{ taskId: string; workspacePath: string; workspaceIdentity?: string }>;
  sendPrompt(params: {
    taskId: string;
    traceId: never;
    content: string;
    clientMode?: "desktop-continuous" | "web-remote-replayable";
  }): Promise<void>;
  /**
   * 停止目标执行；`expectedExecutionId` 是防误停凭据，由既有 runtime 在同一 owner 内
   * 原子比较。旧执行已结束或被新 run 取代时返回 `applied: false`，调用方不得重试新 run。
   */
  stopGeneration(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    expectedExecutionId?: string;
  }): Promise<{ applied: boolean; reason?: "stale" | "not_running" }>;
  renameTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }): Promise<unknown>;
  setTaskPinned(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    pinned: boolean;
  }): Promise<unknown>;
  archiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<unknown>;
  unarchiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<unknown>;
}

export interface AppControlAgentPort {
  readSessionMessages(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    afterMessageId?: string;
    limit?: number;
  }): Promise<readonly { id: string; role: string; text: string }[]>;
  /**
   * 只读现有 runtime 的活动执行事实（不冷恢复、不启动会话）。
   * `executionId` 是停止凭据；拿不到时调用方必须当作没有可中断执行。
   */
  readLiveSession(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
  }): Promise<AppControlLiveSession | undefined>;
  /**
   * V4 投影行分页（真实 conversation/rowsRange owner）。App fork 用它把
   * ReadSession 的 messageId 显式映射成 row target，并取同一次快照的 revision/logEpoch。
   */
  readConversationRows?(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    beforeRowId?: number;
    limit: number;
    connectionId: string;
    clientMode?: "desktop-continuous" | "web-remote-replayable";
  }): Promise<AppControlConversationPage>;
  /** 真实 CLI v4 forkAssistant owner；`unsupported` 表示旧 Agent 不认识该命令。 */
  forkAssistant?(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    target: { rowId: number; entityId: string };
    baseRevision: number;
    baseLogEpoch: string;
    commandId: string;
    clientId: string;
    clientMode?: "desktop-continuous" | "web-remote-replayable";
  }): Promise<AppControlForkCommandResult>;
}

export type AppControlLiveStatus = "unknown" | "idle" | "running" | "needs_attention";

export interface AppControlLiveSession {
  status: AppControlLiveStatus;
  executionId?: string;
}

/** 目录快照里的一行任务；App control 只把它当成只读事实。 */
export interface AppControlTaskRow {
  taskId: string;
  hostId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId: string | null;
  title: string;
  status?: string;
  updatedAt: number;
}

export interface AppControlServiceDependencies {
  /** 本服务所属 Host 的稳定 id；跨 Host 的引用一律拒绝。 */
  sourceServerId: string;
  projects: AppControlProjectPort;
  tasks: AppControlTaskPort;
  agent: AppControlAgentPort;
  discovery?: AppControlDiscoveryPort;
  /** 只在 Desktop Host 注入；没有导航 owner 时 openSession 明确报 unavailable。 */
  navigation?: AppControlNavigationPort;
}

/** 便捷别名：Agent 端口的最小结构；Host 装配按能力逐项注入，旧 Agent 可缺失 fork 端口。 */
export type AppControlAgentLike = Pick<IZCodeAgentService, "readSessionMessages"> & {
  readConversationRows?: NonNullable<AppControlAgentPort["readConversationRows"]>;
  forkAssistant?: NonNullable<AppControlAgentPort["forkAssistant"]>;
};
