import type {
  ExecutionPort,
  LocalSettingStorePort,
  Logger,
  LoggerFactory,
  McpPort,
  McpServerConfig,
  ProjectId,
  SessionId,
  SessionStorePort,
  SupportedLocale,
  TraceContext,
  UiLocale,
} from "@zcode/contracts";
import type { ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntime } from "@zcode/core";
import type { ModelSelection } from "@zcode/provider";
import type { ResolvedRegistrySelection } from "./provider-registry-selection.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import type { PrepareUserExecutionBoundary, ZCodeApp } from "./types.js";

export type SessionFacade = Pick<
  ZCodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "callMcpToolForUi"
  | "getMcpAppConnectionSnapshot"
  | "onMcpAppConnectionInvalidated"
  | "replaceMcpAppProvidedTools"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "sampleModel"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "listCheckpoints"
  | "listMcpServers"
  | "getMcpToolVisibility"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readMcpResource"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "unsubscribeMcpResourcesForUi"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;

export interface SessionResourceCloseInput {
  beginShutdown: () => void;
  closeBrowserSession: () => Promise<void>;
  closeExecution?: () => Promise<void> | void;
  closeMcp?: () => Promise<void> | void;
  closeNodeReplBrowserBroker?: () => Promise<void> | void;
  closeSessionStore?: () => void;
  logger: Logger;
  timeoutMs?: number;
}

export interface CreateSessionFacadeDeps {
  /**
   * 停下本会话拥有的 dwf run：
   * run service 的 `close()`。缺席即本装配没有 dwf 端口（journal 窄化失败、测试装配）。
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}

export interface SessionFacadeState {
  /** App-Provided Tools：本会话当前登记在 ToolRegistry 里的模型侧名字（整体替换时先注销）。 */
  appProvidedToolNames: string[];
  currentLocale: SupportedLocale;
}

export interface SessionFacadeContext {
  readonly deps: CreateSessionFacadeDeps;
  readonly state: SessionFacadeState;
  currentRegistrySelection(): RegistrySelectionState;
  setCurrentLocale(locale: SupportedLocale): void;
}

export type RegistrySelectionState =
  | { owned: false }
  | {
      owned: true;
      registry: ProviderRegistryModelSource;
      selection?: ResolvedRegistrySelection;
    };
