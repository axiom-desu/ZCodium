// 旧 session/*、workspace/*、plugins/*、mcp*/* 方法分派。执行函数仍来自
// server-operations / plugins / mcp-ui，本模块只负责方法路由与 operation 信号接线。
import type { ZCodeProtocolRequest } from "@zcode/shared";
import { zcodeProtocolMethods, zcodeWorkspaceHookTrustGrantParamsSchema } from "@zcode/shared";
import {
  cancelBackgroundTask,
  closeSession,
  compactSession,
  createSession,
  forkSession,
  generateWorkspaceText,
  goalSession,
  getTaskTokenUsage,
  getUsageStats,
  listSessions,
  listSessionSubagents,
  readEvents,
  readMessages,
  readSession,
  resumeSession,
  sendPrompt,
  setMode,
  setModel,
  setThoughtLevel,
  stopSession,
  subscribeSession,
} from "./server-operations.js";
import { listChildProcesses } from "./process-child-processes.js";
import {
  readWorkspacePresentation,
  testProviderModelConnectivity,
} from "./workspace-model-runtime.js";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
} from "./plugins.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "./plugin-reference-catalog.js";
import { getSkillReferenceCatalog } from "./skill-reference-catalog.js";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "./saved-workflows.js";
import { listMcpServers } from "./mcp.js";
import {
  callMcpUiTool,
  sampleMcpUi,
  cancelMcpUiSampling,
  cancelMcpUiToolCall,
  listMcpUiResourceTemplates,
  listMcpUiResources,
  claimMcpUiAppToolCall,
  registerMcpUiAppTools,
  resolveMcpUiAppToolCall,
  unregisterMcpUiAppTools,
  readMcpUiResource,
  readMcpUiResourceForUi,
  subscribeMcpUiResource,
  unsubscribeMcpUiResource,
  closeMcpUiInstance,
  openMcpUiInstance,
  validateMcpUiInstance,
} from "./mcp-ui/index.js";
import { listPluginUiSurfaces } from "./plugin-ui-surfaces.js";
import { updateInteractionPreferences } from "./interaction-preferences.js";
import { updateDynamicWorkflowPolicy } from "./dynamic-workflow-policy.js";
import { grantWorkspaceHookTrustForProtocol } from "./workspace-hook-trust.js";
import { querySessionDebug } from "./session-debug.js";
import type { ZCodeProtocolSessionRecord } from "./server-types.js";
import { UNHANDLED_REQUEST, type ProtocolRequestDispatchHost } from "./server-dispatch-types.js";
import {
  cancelPluginOperation,
  cancelWorkspaceGenerateText,
  withPluginOperationSignal,
  withWorkspaceGenerateTextSignal,
} from "./server-operation-signals.js";

async function notifyWorkspaceHookTrustGrantSessions(input: {
  grantedWorkspaceKey?: string;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
}): Promise<void> {
  if (!input.grantedWorkspaceKey) return;
  await Promise.all(
    [...input.sessions.values()]
      .filter((record) => record.workspace.workspaceKey === input.grantedWorkspaceKey)
      .map((record) => record.app.reloadWorkspaceHookTrust()),
  );
}
export async function dispatchLegacyRequest(
  host: ProtocolRequestDispatchHost,
  request: ZCodeProtocolRequest,
): Promise<unknown | typeof UNHANDLED_REQUEST> {
  switch (request.method) {
    case zcodeProtocolMethods.sessionCreate:
      return await createSession(host.context, request.params, request.trace);
    case zcodeProtocolMethods.sessionResume:
      return await resumeSession(host.context, request.params);
    case zcodeProtocolMethods.sessionList:
      return await listSessions(host.context, request.params);
    case zcodeProtocolMethods.sessionSubagents:
      return await listSessionSubagents(host.context, request.params);
    case zcodeProtocolMethods.sessionRead:
      return await readSession(host.context, request.params);
    case zcodeProtocolMethods.sessionMessages:
      return await readMessages(host.context, request.params);
    case zcodeProtocolMethods.sessionEvents:
      return await readEvents(host.context, request.params);
    case zcodeProtocolMethods.sessionSubscribe:
      return await subscribeSession(host.context, request.params);
    case zcodeProtocolMethods.sessionSend:
      return await sendPrompt(host.context, request.params);
    case zcodeProtocolMethods.sessionStop:
      return await stopSession(host.context, request.params);
    case zcodeProtocolMethods.sessionCancelBackgroundTask:
      return await cancelBackgroundTask(host.context, request.params);
    case zcodeProtocolMethods.sessionFork:
      return await forkSession(host.context, request.params);
    case zcodeProtocolMethods.sessionCompact:
      return await compactSession(host.context, request.params);
    case zcodeProtocolMethods.sessionGoal:
      return await goalSession(host.context, request.params);
    case zcodeProtocolMethods.sessionSetModel:
      return await setModel(host.context, request.params);
    case zcodeProtocolMethods.sessionSetThoughtLevel:
      return await setThoughtLevel(host.context, request.params);
    case zcodeProtocolMethods.sessionSetMode:
      return await setMode(host.context, request.params);
    case zcodeProtocolMethods.sessionClose:
      return await closeSession(host.context, request.params);
    case zcodeProtocolMethods.workspaceReadPresentation:
      return await readWorkspacePresentation(host.context, request.params);
    case zcodeProtocolMethods.workspaceHookTrustGrant: {
      const grantResult = await grantWorkspaceHookTrustForProtocol(request.params, {
        appVersion: host.context.deps.version,
        policyProvider: host.context.deps.workspaceHookPolicyProvider,
      });
      if (grantResult.accepted) {
        await notifyWorkspaceHookTrustGrantSessions({
          // dispatch 层的 params 是弱类型；grant 内部已用同一 schema parse 过，这里
          // safeParse 只为取出 workspaceKey 做匹配，失败即跳过通知（防御，正常必成功）。
          grantedWorkspaceKey: zcodeWorkspaceHookTrustGrantParamsSchema.safeParse(request.params)
            .success
            ? zcodeWorkspaceHookTrustGrantParamsSchema.parse(request.params).workspace.workspaceKey
            : undefined,
          sessions: host.context.sessions,
        });
      }
      return grantResult;
    }
    case zcodeProtocolMethods.workspaceUpdateInteractionPreferences:
      return await updateInteractionPreferences(host.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy:
      return await updateDynamicWorkflowPolicy(host.context, request.params);
    case zcodeProtocolMethods.workspaceGenerateText:
      return await withWorkspaceGenerateTextSignal(
        host.workspaceGenerateTextControllers,
        request,
        (signal) => generateWorkspaceText(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.workspaceCancelGenerateText:
      return cancelWorkspaceGenerateText(host.workspaceGenerateTextControllers, request.params);
    case zcodeProtocolMethods.providerTestModelConnectivity:
      return await testProviderModelConnectivity(host.context, request.params);
    case zcodeProtocolMethods.mcpList:
      return await listMcpServers(host.context, request.params);
    case zcodeProtocolMethods.mcpReadResource:
      return await readMcpUiResource(host.context, request.params);
    case zcodeProtocolMethods.mcpUiOpenInstance:
      return openMcpUiInstance(host.context, request.params);
    case zcodeProtocolMethods.mcpUiValidateInstance:
      return validateMcpUiInstance(host.context, request.params);
    case zcodeProtocolMethods.mcpUiCloseInstance:
      return closeMcpUiInstance(host.context, request.params);
    case zcodeProtocolMethods.mcpUiSampling:
      return sampleMcpUi(host.context, request.params);
    case zcodeProtocolMethods.mcpUiCancelSampling:
      return cancelMcpUiSampling(host.context, request.params);
    case zcodeProtocolMethods.mcpUiCallTool:
      return await callMcpUiTool(host.context, request.params);
    case zcodeProtocolMethods.mcpUiCancelCall:
      return await cancelMcpUiToolCall(host.context, request.params);
    case zcodeProtocolMethods.mcpUiReadResource:
      return await readMcpUiResourceForUi(host.context, request.params);
    case zcodeProtocolMethods.mcpUiListResources:
      return await listMcpUiResources(host.context, request.params);
    case zcodeProtocolMethods.mcpUiListResourceTemplates:
      return await listMcpUiResourceTemplates(host.context, request.params);
    case zcodeProtocolMethods.mcpUiSubscribeResource:
      return await subscribeMcpUiResource(host.context, request.params);
    case zcodeProtocolMethods.mcpUiUnsubscribeResource:
      return await unsubscribeMcpUiResource(host.context, request.params);
    case zcodeProtocolMethods.mcpUiRegisterAppTools:
      return await registerMcpUiAppTools(host.context, request.params);
    case zcodeProtocolMethods.mcpUiUnregisterAppTools:
      return await unregisterMcpUiAppTools(host.context, request.params);
    case zcodeProtocolMethods.mcpUiClaimAppToolCall:
      return await claimMcpUiAppToolCall(host.context, request.params);
    case zcodeProtocolMethods.mcpUiResolveAppToolCall:
      return await resolveMcpUiAppToolCall(host.context, request.params);
    case zcodeProtocolMethods.pluginsList:
      return await listPlugins(host.context, request.params);
    case zcodeProtocolMethods.pluginsReferenceCatalogWithCategory:
      return await getPluginReferenceCatalog(host.context, request.params, true);
    case zcodeProtocolMethods.pluginsReferenceCatalog:
      return await getPluginReferenceCatalog(host.context, request.params);
    case zcodeProtocolMethods.pluginsListUiSurfaces:
      return await listPluginUiSurfaces(host.context, request.params);
    case zcodeProtocolMethods.skillsReferenceCatalog:
      return await getSkillReferenceCatalog(host.context, request.params);
    case zcodeProtocolMethods.workflowsList:
      return await listSavedWorkflowsOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsGet:
      return await getSavedWorkflowOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsUpdateMeta:
      return await updateSavedWorkflowMetaOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsDelete:
      return await deleteSavedWorkflowOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsRuns:
      return await listSavedWorkflowRunsOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsMove:
      return await moveSavedWorkflowOp(host.context, request.params);
    case zcodeProtocolMethods.pluginsResolveSuggestedReference:
      return await withPluginOperationSignal(host.pluginOperationControllers, request, (signal) =>
        resolveSuggestedPluginReference(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsSetEnabled:
      return await withPluginOperationSignal(host.pluginOperationControllers, request, (signal) =>
        setPluginEnabled(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsOverview:
      return await getPluginsOverview(host.context, request.params);
    case zcodeProtocolMethods.processChildProcesses:
      return listChildProcesses(host.context.deps.mcpProcesses?.listProcesses() ?? []);
    case zcodeProtocolMethods.runtimeCapabilities:
      return { independentPlanState: true };
    case zcodeProtocolMethods.pluginsMarketplaceAdd:
      return await withPluginOperationSignal(host.pluginOperationControllers, request, (signal) =>
        addPluginMarketplace(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsMarketplaceRemove:
      return await removePluginMarketplace(host.context, request.params);
    case zcodeProtocolMethods.pluginsMarketplaceUpdate:
      return await withPluginOperationSignal(host.pluginOperationControllers, request, (signal) =>
        updatePluginMarketplace(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsInstall:
      return await withPluginOperationSignal(host.pluginOperationControllers, request, (signal) =>
        installPlugin(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsCancelOperation:
      return cancelPluginOperation(host.pluginOperationControllers, request.params);
    case zcodeProtocolMethods.pluginsUninstall:
      return await uninstallPlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsUpdate:
      return await updatePlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsRestoreBuiltin:
      return await restoreBuiltinPlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsConfigure:
      return await configurePlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsResetConfig:
      return await resetPluginConfig(host.context, request.params);
    case zcodeProtocolMethods.pluginsValidate:
      return await validatePlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsDescribe:
      return await describePlugin(host.context, request.params);
    case zcodeProtocolMethods.usageStats:
      return await getUsageStats(host.context, request.params);
    case zcodeProtocolMethods.sessionDebug:
      return querySessionDebug(host.context, request.params);
    case zcodeProtocolMethods.sessionUsage:
      return await getTaskTokenUsage(host.context, request.params);
    default:
      return UNHANDLED_REQUEST;
  }
}
