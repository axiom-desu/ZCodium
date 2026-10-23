import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { McpAppsToolVisibility } from "@zcode/shared/mcp-apps";
import type { CollaborationMode } from "@zcode/contracts";
import type {
  McpListResourceTemplatesResult,
  McpListResourcesResult,
  McpReadResourceResult,
  McpServerStatus,
  InputHistoryEntry,
  TraceContext,
  ModelSelection,
  ModelToolCall,
  ModelUsage,
  PluginLoadOutcome,
  PluginReferenceCatalog,
  SessionGoal,
  SkillLoadOutcome,
  SupportedLocale,
  TodoItem,
  ToolArtifactReadResult,
  UiThemePreference,
} from "@zcode/contracts";
import type { SubmitPromptOptions } from "./types.js";
import type {
  AgentRuntime,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceGenerateTextInput,
} from "@zcode/core";
import type { ZCodeModelOption } from "@zcode/shared";
import type { SessionTranscriptMessage } from "../session-transcript.js";

export interface ZCodeAppQuerySurface {
  getMode(): CollaborationMode;
  getModel(): string;
  /** current-only 协议快照精确读取当前 Registry 模型，避免枚举整个目录。 */
  getCurrentModelOption?(): ZCodeModelOption | undefined;
  /** 只读 Registry 元数据；不要求选项完整，也不绑定执行模型。 */
  getModelOption?(selection: ModelSelection): ZCodeModelOption | undefined;
  getLocale(): SupportedLocale;
  getTheme(): UiThemePreference;
  getDefaultThoughtLevel(): string | undefined;
  getThoughtLevel(): string | undefined;
  loadSessionTranscript(): Promise<SessionTranscriptMessage[]>;
  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
  readSubagentTranscript(
    childSessionId: string,
  ): Promise<import("./subagent-observation.js").SubagentTranscriptSnapshot>;
  readTodos(): Promise<TodoItem[]>;
  readTarget(): Promise<SessionGoal | null>;
  setCustomSessionTitle(input: { title: string; traceContext?: TraceContext }): Promise<void>;
  readToolResultArtifact(uri: string): Promise<ToolArtifactReadResult>;
  /** chunk transaction commit 后把完整二进制原子寄存到 session artifact store。 */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
  /** 已发送 image/video 预览：在拥有 session 的 runtime 内读取 artifact 或实际路径。 */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Share 选择阶段只读 userInput 附件元数据；不读取完整内容。 */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop local 已发送视频：解析 artifact-first 本地播放源；否则保持分片读取。 */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;
  continueActiveTarget(options?: SubmitPromptOptions): Promise<TurnResult | null>;
  recallPreviousInputHistory(skip?: number): Promise<InputHistoryEntry | null>;
  listModels(): ZCodeModelOption[];
  listThoughtLevels(): string[];
  listPlugins(): Promise<PluginLoadOutcome>;
  getPluginReferenceCatalog(): PluginReferenceCatalog;
  getSkillCatalog(): Promise<SkillLoadOutcome>;
  listMcpServers(): Promise<Record<string, McpServerStatus>>;
  readMcpResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;
  readMcpResourceForUi(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;
  getMcpAppConnectionSnapshot(serverName: string): { identity: string; generation: number } | null;
  getMcpToolVisibility(
    serverName: string,
    toolName: string,
  ): Promise<readonly McpAppsToolVisibility[] | null>;
  /**
   * App-Provided Tools：用给定集合整体替换本会话的 App 工具，失效工具缓存让下一次模型请求可见。
   * 与非 App 工具重名的定义跳过。返回实际登记的模型侧名字。
   */
  listMcpResourcesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpListResourcesResult>;
  listMcpResourceTemplatesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpListResourceTemplatesResult>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  disconnectMcpServer(name: string): Promise<McpServerStatus | undefined>;
  listCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  sampleModel(
    input: Parameters<AgentRuntime["sampleModel"]>[0],
    options: Parameters<AgentRuntime["sampleModel"]>[1],
  ): ReturnType<AgentRuntime["sampleModel"]>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<{
    text: string;
    selection: WorkspaceGenerateTextInput["selection"];
    finishReason: string;
    usage?: ModelUsage;
    toolCalls?: ModelToolCall[];
  }>;
  testModelConnectivity(
    input: { selection: ModelSelection },
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
}
