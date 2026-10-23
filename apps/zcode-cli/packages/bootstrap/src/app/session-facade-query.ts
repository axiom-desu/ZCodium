import type { UiThemePreference } from "@zcode/contracts";
import { McpResourceSubscribeUnsupportedError, resolveMcpToolVisibility } from "@zcode/contracts";
import { normalizeModelSelection } from "@zcode/provider";
import { listMcpServerStatuses } from "../mcp-config.js";
import { loadSessionTranscriptFromStore } from "../session-transcript.js";
import {
  completeAuxiliaryRegistryModelSelection,
  getRegistryBackedModel,
  listRegistryBackedModels,
  resolveRegistryThoughtLevel,
} from "./provider-registry-selection.js";
import { createSubagentObservation } from "./subagent-observation.js";
import { formatLegacyRuntimeModelValue } from "./session-facade-helpers.js";
import type { SessionFacade, SessionFacadeContext } from "./session-facade-types.js";
import type { SessionTargetOperations } from "./session-facade-target.js";

export function createSessionFacadeQueries(
  context: SessionFacadeContext,
  target: SessionTargetOperations,
): Pick<
  SessionFacade,
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getTheme"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "loadSessionTranscript"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "listModels"
  | "listThoughtLevels"
  | "listMcpServers"
  | "readMcpResource"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "getMcpAppConnectionSnapshot"
  | "getMcpToolVisibility"
  | "readBackgroundBashOutput"
  | "listCheckpoints"
  | "sampleModel"
  | "generateWorkspaceText"
  | "testModelConnectivity"
> {
  const deps = context.deps;
  const currentRegistrySelection = () => context.currentRegistrySelection();
  return {
    getMode: () => deps.runtime.getMode(),
    getModel: () => formatLegacyRuntimeModelValue(deps.runtime.getSessionModelSelection()),
    getLocale: () => context.state.currentLocale,
    getTheme: () => deps.configResult.config.ui.theme as UiThemePreference,
    getDefaultThoughtLevel: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? resolveRegistryThoughtLevel(registryState.selection)
        : deps.runtime.getSessionModelSelection()?.options?.reasoningLevel;
    },
    // 当前档位只读会话事实；缺失时不能借默认档位伪装成已完成选择。
    getThoughtLevel: () => deps.runtime.getSessionModelSelection()?.options?.reasoningLevel,
    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    readTarget: target.readTarget,
    listModels: () => {
      return listRegistryBackedModels(deps.providerRegistry);
    },
    getCurrentModelOption: () => {
      const selection = deps.runtime.getSessionModelSelection();
      return selection && getRegistryBackedModel(deps.providerRegistry, selection);
    },
    getModelOption: (selection) => getRegistryBackedModel(deps.providerRegistry, selection),
    listThoughtLevels: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? [...(registryState.selection?.model.config.optionSpecs.reasoningLevel.values ?? [])]
        : [];
    },
    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),
    readMcpResource: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    readMcpResourceForUi: async (serverName, uri, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      if (!deps.mcpPort.readResource) {
        throw new Error("MCP resources are not supported by this runtime");
      }
      return deps.mcpPort.readResource(
        { serverName, uri, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourcesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResources) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResources(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    listMcpResourceTemplatesForUi: async (serverName, cursor, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.listResourceTemplates) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      return deps.mcpPort.listResourceTemplates(
        { serverName, ...(cursor ? { cursor } : {}), trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    getMcpAppConnectionSnapshot: (name) => deps.mcpPort?.appConnectionSnapshot?.(name) ?? null,
    getMcpToolVisibility: async (serverName, toolName) => {
      if (!deps.mcpPort) return null;
      // 真相是 adapter 归一化过的 descriptor（同一份 tools/list），不另存副本。
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      return descriptor ? resolveMcpToolVisibility(descriptor) : null;
    },
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    sampleModel: (input, options) =>
      deps.runtime.sampleModel(input, {
        ...options,
        traceContext: options.traceContext ?? deps.traceContext,
      }),
    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口只规范化模型身份；具体的最低档位由 Core 的辅助请求调用点显式决定。
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    testModelConnectivity: async (input, options) => {
      // 连接测试用的 Model 也要先绑定最低档位，否则严格 Factory 会先因缺档位失败。
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
  };
}
