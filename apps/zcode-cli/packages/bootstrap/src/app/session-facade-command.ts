import type { CollaborationMode, MessageId } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/provider";
import { updateUiLocaleInFileConfig } from "@zcode/adapters/config";
import {
  McpResourceSubscribeUnsupportedError,
  resolveMcpToolVisibility,
  traceContextToLogContext,
} from "@zcode/contracts";
import { createMcpAppProvidedToolEntry, createMcpToolEntry, toMcpToolName } from "@zcode/core";
import { getLocaleConfigPath } from "./locale-selection.js";
import {
  requireRegistryThoughtLevel,
  resolveRegistryOwnedModelSelection,
  resolveRegistryOwnedSelection,
  resolveRegistryThoughtLevel,
} from "./provider-registry-selection.js";

import { formatLegacyRuntimeModelValue } from "./session-facade-helpers.js";
import type { SessionFacade, SessionFacadeContext } from "./session-facade-types.js";
import type { SessionTargetOperations } from "./session-facade-target.js";

export function createSessionFacadeCommands(
  context: SessionFacadeContext,
  target: SessionTargetOperations,
  persistSessionModelSelection: () => Promise<void>,
): Pick<
  SessionFacade,
  | "cancelBackgroundTask"
  | "clearTarget"
  | "callMcpToolForUi"
  | "onMcpAppConnectionInvalidated"
  | "replaceMcpAppProvidedTools"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "forkFromCheckpoint"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "unsubscribeMcpResourcesForUi"
> {
  const deps = context.deps;
  const currentRegistrySelection = () => context.currentRegistrySelection();
  return {
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),
    setTarget: target.setTarget,
    updateTargetStatus: target.updateTargetStatus,
    clearTarget: target.clearTarget,
    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },
    subscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort) throw new Error("MCP is disabled");
      if (!deps.mcpPort.subscribeResource) {
        throw new McpResourceSubscribeUnsupportedError(serverName);
      }
      await deps.mcpPort.subscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourceForUi: async (serverName, uri, subscriberKey, options) => {
      if (!deps.mcpPort?.unsubscribeResource) return;
      await deps.mcpPort.unsubscribeResource(
        { serverName, uri, subscriberKey, trace: deps.traceContext },
        { signal: options?.signal },
      );
    },
    unsubscribeMcpResourcesForUi: async (subscriberKeyPrefix) => {
      if (!deps.mcpPort?.unsubscribeResourcesBySubscriber) return 0;
      return deps.mcpPort.unsubscribeResourcesBySubscriber(subscriberKeyPrefix);
    },
    onMcpAppConnectionInvalidated: (name, listener) =>
      deps.mcpPort?.onAppConnectionInvalidated?.(name, listener) ?? (() => {}),
    callMcpToolForUi: async (serverName, toolName, args, options) => {
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      const snapshot = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (!snapshot) throw new Error("MCP App connection is unavailable");
      const descriptor = (await deps.mcpPort.listTools()).find(
        (tool) => tool.serverName === serverName && tool.toolName === toolName,
      );
      if (!descriptor || !resolveMcpToolVisibility(descriptor).includes("app"))
        throw new Error("Tool is not available to this App");
      const registry = deps.runtime.getToolRegistry();
      const registered = registry
        .list()
        .map((name) => registry.get(name))
        .find(
          (entry) =>
            entry?.metadata.mcpPresentation?.serverName === serverName &&
            entry.metadata.mcpPresentation.toolName === toolName,
        );
      const entry =
        registered ??
        createMcpToolEntry(toMcpToolName(descriptor), descriptor, deps.mcpPort, false);
      const executor = deps.runtime.getToolExecutor();
      if (!executor.authorizeAppTool) throw new Error("MCP App host authorization is unavailable");
      const input = await executor.authorizeAppTool(
        { id: crypto.randomUUID(), name: entry.metadata.name, input: args ?? {} },
        entry,
        { signal: options?.signal, traceContext: deps.traceContext },
      );
      // 审批期间连接可能被替换：批准只属于原连接，执行前必须再次验证。
      options?.signal?.throwIfAborted();
      const current = deps.mcpPort.appConnectionSnapshot?.(serverName);
      if (
        !current ||
        current.identity !== snapshot.identity ||
        current.generation !== snapshot.generation
      )
        throw new Error("MCP App connection changed during authorization");
      return deps.mcpPort.callTool(
        {
          serverName,
          toolName,
          arguments: input as Record<string, unknown>,
          trace: deps.traceContext,
          runtimeScope: "main",
        },
        { signal: options?.signal, appConnection: snapshot },
      );
    },
    replaceMcpAppProvidedTools: (definitions, execute) => {
      const registry = deps.runtime.getToolRegistry();
      for (const name of context.state.appProvidedToolNames) registry.unregister(name);
      const registered: string[] = [];
      for (const definition of definitions) {
        // 不覆盖内置 / MCP 工具：`app__` 前缀本不该冲突，冲突时以既有工具为准。
        if (registry.has(definition.modelName) || registered.includes(definition.modelName))
          continue;
        registry.register(createMcpAppProvidedToolEntry(definition, execute), {
          silentDuplicateWarning: true,
        });
        registered.push(definition.modelName);
      }
      context.state.appProvidedToolNames = registered;
      // 同回合下一次模型请求即可见：只是让 getTools 重建缓存；工具集合没变时发给模型的内容也不变。
      deps.runtime.invalidateToolCache();
      return registered;
    },
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    setMode: async (mode: CollaborationMode) => {
      const previousMode = deps.runtime.getMode();
      await deps.runtime.setExecutionState({ mode }, deps.traceContext);
      if (deps.localSettingStore) {
        try {
          await deps.localSettingStore.saveProjectPermissionMode({
            mode: deps.runtime.getMode(),
            projectID: deps.projectID,
          });
        } catch (error) {
          deps.logger.warn("Project mode preference write failed", {
            ...traceContextToLogContext(deps.traceContext),
            error: error instanceof Error ? error.message : String(error),
            event: "local_setting.permission_mode.write_failed",
            mode,
            module: "bootstrap",
            projectId: deps.projectID,
            status: "failed",
          });
        }
      }
      deps.logger.info("Session mode updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.mode.updated",
        mode,
        module: "bootstrap",
        previousMode,
        status: "completed",
      });
      return {
        mode: deps.runtime.getMode(),
        previousMode,
        traceId: deps.traceContext.traceId,
      };
    },
    setModel: async (modelId, options) => {
      // 配置命令已提交完整 Selection；转成字符串会丢档位。先整体校验再一次
      // 更新/保存，非法档位不能留下已换模型的半次修改。旧字符串入口保留只改身份语义。
      const registrySelection =
        typeof modelId === "string"
          ? resolveRegistryOwnedSelection(
              deps.providerRegistry,
              modelId,
              deps.configuredDefaultModelSelection,
              { allowMissingReasoning: true },
            )
          : resolveRegistryOwnedModelSelection(deps.providerRegistry, modelId);
      if (!registrySelection) {
        throw new Error(`Provider Registry 中不存在 Model: ${modelId}`);
      }
      const previousSelection = deps.runtime.getSessionModelSelection();
      const previousModel = formatLegacyRuntimeModelValue(previousSelection);
      const model = formatLegacyRuntimeModelValue(registrySelection.selection);
      const sessionSelection: ModelSelection = {
        providerId: registrySelection.selection.providerId,
        modelId: registrySelection.selection.modelId,
        ...(typeof modelId !== "string" && registrySelection.selection.options
          ? { options: { ...registrySelection.selection.options } }
          : {}),
      };
      deps.runtime.setSessionModelSelection(sessionSelection);
      if (!options?.transient) {
        deps.runtime.recordPendingModelChange({
          fromModel: previousSelection,
          fromModelLabel: previousModel,
          toModel: sessionSelection,
          toModelLabel: model,
        });
        await persistSessionModelSelection();
      }
      deps.logger.info("Session model updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.model.updated",
        model,
        module: "bootstrap",
        previousModel,
        status: "completed",
      });
      return {
        model,
        previousModel,
        traceId: deps.traceContext.traceId,
      };
    },
    setThoughtLevel: async (level) => {
      const registryState = currentRegistrySelection();
      if (registryState.owned) {
        const currentSelection = deps.runtime.getSessionModelSelection();
        if (!currentSelection) throw new Error("Select a model before choosing reasoning effort");
        const registrySelection =
          registryState.selection ??
          resolveRegistryOwnedModelSelection(registryState.registry, {
            providerId: currentSelection.providerId,
            modelId: currentSelection.modelId,
          })!;
        const previousThoughtLevel = resolveRegistryThoughtLevel(
          registrySelection,
          currentSelection.options?.reasoningLevel,
        );
        const thoughtLevel = requireRegistryThoughtLevel(registrySelection, level);
        deps.runtime.setSessionModelSelection({
          ...currentSelection,
          options: {
            ...currentSelection.options,
            reasoningLevel: thoughtLevel,
          },
        });
        await persistSessionModelSelection();
        deps.logger.info("Session reasoning effort updated", {
          ...traceContextToLogContext(deps.traceContext),
          event: "session.reasoning_effort.updated",
          module: "bootstrap",
          previousThoughtLevel,
          status: "completed",
          thoughtLevel,
        });
        return {
          previousThoughtLevel,
          thoughtLevel,
          traceId: deps.traceContext.traceId,
        };
      }
      throw new Error("当前 Session Model 不属于 Provider Registry");
    },
    setLocale: async (locale) => {
      const previousLocale = context.state.currentLocale;
      const configPath = getLocaleConfigPath(deps.configResult);
      const persisted = await updateUiLocaleInFileConfig(configPath, locale);
      context.setCurrentLocale(deps.resolveUiLocale(locale));
      deps.configResult.config.ui.locale = context.state.currentLocale;
      deps.logger.info("Session locale updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.locale.updated",
        locale: context.state.currentLocale,
        module: "bootstrap",
        previousLocale,
        requestedLocale: locale,
        status: "completed",
      });
      return {
        configPath: persisted.path,
        locale: context.state.currentLocale,
        previousLocale,
        requestedLocale: locale,
        traceId: deps.traceContext.traceId,
      };
    },
  };
}
