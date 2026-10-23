// ToolExecutionContext 构造：把 executor deps 与本次调用的 trace/timeout 关系投影成
// handler 可见的上下文。所有端口都指向 deps 上的同一实例，不复制状态。

import { type SessionEvent, type TurnId, type TraceContext } from "@zcode/contracts";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import type { ExecutableToolCall, ToolExecutionContext, ToolExecutionResult } from "../types.js";
import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";
import { observeToolAdmissionClock, type ToolDeadline } from "./timeout.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

export function createToolExecutionContext(input: {
  deps: ToolExecutorDeps;
  canonicalToolCall: ExecutableToolCall;
  executionInput: unknown;
  traceContext: TraceContext;
  traceId: ToolExecutionContext["traceId"];
  turnId: TurnId | undefined;
  options: ToolExecuteOptions | undefined;
  deadline: ToolDeadline;
  abortSignal: AbortSignal;
  onReadFileStateMetadata: (metadata: ToolExecutionResult["readFileStateMetadata"]) => void;
}): ToolExecutionContext {
  const { deps, canonicalToolCall, traceContext, traceId, turnId, options, deadline } = input;
  const model = options?.model ?? deps.model;
  const emitEvent =
    deps.emitEvent === undefined
      ? undefined
      : async (event: SessionEvent): Promise<void> => {
          observeToolAdmissionClock(event, canonicalToolCall.id, deadline);
          await deps.emitEvent!(event);
        };

  const bashShellSelection = deps.getBashShellSelection?.() ?? deps.bashShellSelection;
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: deps.registry.has("Bash"),
  });
  const context: ToolExecutionContext = {
    toolSearch: options?.toolSearch,
    toolCallId: canonicalToolCall.id,
    automationTurn: options?.automationTurn,
    traceContext,
    traceId,
    spanId: traceContext.spanId,
    parentSpanId: traceContext.parentSpanId,
    abortSignal: input.abortSignal,
    backgroundTaskControlPort: deps.backgroundTaskControlPort,
    emitEvent,
    executionPort: deps.executionPort,
    browserControlPort: deps.browserControlPort,
    browserDocumentationRoot: deps.browserDocumentationRoot,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    pdfDocumentPort: deps.pdfDocumentPort,
    // 工具内部的模型请求默认把状态事件发进会话：deadline 暂停与 driver 相位都靠这条流。
    model: withDefaultToolModelStatusSink(
      model,
      createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
    ),
    subagentModelOverride: options?.subagentModelOverride,
    embeddedSearch: {
      ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
      enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
      ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
    },
    skillPort: deps.skillPort,
    subagentPort: deps.subagentPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    artifactStore: deps.artifactStore,
    automationPort: deps.automationPort,
    sessionStore: deps.sessionStore,
    sessionModePort: deps.sessionModePort,
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: deps.runtimeTaskRegistry,
    readFileState: deps.readFileState,
    recordReadFileStateMetadata: (metadata) => {
      input.onReadFileStateMetadata(metadata);
    },

    bashShellSelection,
    setWorkingDirectory: deps.setWorkingDirectory,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
    workspaceIdentity: deps.workspaceIdentity,
    remoteSessionId: deps.remoteSessionId,
    clientMode: deps.clientMode,
    deliveryKind: deps.deliveryKind,
    memoryRoot: deps.getMemoryRoot?.(),
    runtimeScope: deps.runtimeScope,
    providerVisibleToolNames: deps.registry
      .list()
      .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
    sessionId: deps.sessionId,
    turnId,
  };

  return context;
}
