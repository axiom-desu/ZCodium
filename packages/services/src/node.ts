/* eslint-disable max-lines -- host process 服务注册和启动装配需要集中维护，拆散后会更难追踪依赖注入顺序 */
// Node.js service implementations — NOT safe to import in browser code
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { getAppConfigDir as resolveAppConfigDir } from "./paths.js";
import {
  ZCODE_USER_DATA_DIR_NAME,
  buildLocalMediaPreviewUrl,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

export {
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";

export { createFileService } from "./file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "./process/processResourceSampler.js";
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
export type { CreateFileServiceOptions } from "./file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "./file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  ZCODE_E2E_FS_FAULTS_ALLOW_ENV,
  ZCODE_E2E_FS_FAULTS_ENV,
} from "./fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "./fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
export { createGitService } from "./git/gitService.js";
export { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
export { createGitCheckpointService } from "./git/gitCheckpointService.js";
export { createSystemService } from "./system/systemService.js";
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
export { createTerminalService } from "./terminal/terminalService.js";
export { createSettingService } from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
export { createBroadcastService } from "./broadcast/broadcastService.js";
export { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
export { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
export { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
export {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export { ZCodeProtocolClient } from "./zcode-agent/zcodeProtocolClient.js";
export type { ZCodeProtocolTransport } from "./zcode-agent/zcodeProtocolTransport.js";
export { ZCodeStdioTransport } from "./zcode-agent/zcodeStdioTransport.js";
export {
  getZCodeStdioTapDevLogDir,
  readZCodeStdioTapDevState,
  setZCodeStdioTapDevEnabled,
} from "./zcode-agent/zcodeStdioTapDevConfig.js";
export type { ZCodeStdioTapDevState } from "@zcode/shared";
export { createBotsService } from "./bots/botsService.js";
export { createAstrBotBotProvider } from "./bots/providers/astrbotProvider.js";
export type { AstrBotProvider, AstrBotProviderOptions } from "./bots/providers/astrbotProvider.js";
// desktop 的 host 只需要传输类型与专用 getter。BotsDeliveryLog 类、BOTS_DELIVERY_WINDOW、
// BotsDeliveryRecord 以及 IAstrBotBridgeService 描述符都是 provider 私有实现，不再提升为
// 包公开 API：否则后续调整窗口/ack 策略会被外部消费者牵制。
export type { AstrBotBridgeTransport } from "./bots/astrbotBridgePort.js";
export { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
export { importLegacyPersonalProviderConfig } from "./model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "./model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "./model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  ProviderRuntime,
} from "./model-provider/providerRuntime.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "./model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "./model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "./model-provider/providerProvisioningTarget.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
export { createUsageStatsService } from "./usage-stats/usageStatsService.js";
// Storage：service 与 adapters 工厂；desktop host 负责组装（Worker runner 在 desktop 包内）
export { createStorageService } from "./storage/app/storageService.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./storage/app/ports.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "./storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./storage/adapters/volumeProbe.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
export { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
export { createClientConfigService } from "./client-config/clientConfigService.js";
export { createClientScenesService } from "./client-scenes/clientScenesService.js";
export { createSkillsService } from "./skills/skillsService.js";
export { createSkillSyncService } from "./skill-sync/skillSyncService.js";
export { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
export { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
export { createPluginsService } from "./plugins/pluginsService.js";
export { createPluginManagementService } from "./plugins/pluginManagementService.js";
export { createSubagentsService } from "./subagents/subagentsService.js";
export { createCommandsService } from "./commands/commandsService.js";
export { createHooksService } from "./hooks/hooksService.js";
export { createMemoryService } from "./memory/memoryService.js";
export { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
export {
  encodeConversationArchive,
  decodeConversationArchive,
  ConversationArchiveError,
  type ConversationArchiveInput,
  type DecodedConversationArchive,
} from "./conversation-share/conversationArchive.js";
export { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
export {
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "./conversation-share/conversationShareArtifactSource.js";
export { createNodeApiClient, NodeApiClient } from "./providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "./runtime-tools/runtimeCommandEnv.js";

// 定时任务管理与 scheduler 共用同一套 node-only 存储和 cron 语义。
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "./session/automationRepo.js";
export { AutomationService, InvalidCronExprError } from "./session/automationService.js";
// 本地任务文件变更摘要。
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { createServiceLogger, type ServiceLogger } from "./logger/serviceLogger.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./session/automationCron.js";

import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { CuaOperationStateReporter } from "./zcode-agent/cuaOperationTurnTracker.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import {
  createUnsupportedConversationShareService,
  IConversationShareService,
  type IConversationShareService as IConversationShareServiceType,
} from "./conversation-share/conversationShare.js";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "./conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "./conversation-share/conversationShareArtifactSource.js";
import { IBotsService } from "./bots/bots.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IUsageStatsService } from "./usage-stats/usageStats.js";
import { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import { IPluginsService } from "./plugins/plugins.js";
import { IPluginManagementService } from "./plugins/pluginManagement.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { IHooksService } from "./hooks/hooks.js";
import { IMemoryService } from "./memory/memory.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import { createSettingService } from "./setting/settingService.js";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
import type { ZCodeAgentCommandResolver } from "./zcode-agent/zcodeAgentProcessManager.js";
import { resolveZCodeAgentPresentationSurface } from "./zcode-agent/zcodeAgentPresentationSurface.js";
import { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
import { createZCodeTaskIndexSyncer } from "./zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import { createBotsService } from "./bots/botsService.js";
import { createAstrBotBotProvider } from "./bots/providers/astrbotProvider.js";
import type { AstrBotProvider } from "./bots/providers/astrbotProvider.js";
import { createBotRemoteWorkspaceService } from "./bots/botRemoteWorkspaceBridge.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { readLegacyZCodeConfigProviders } from "./model-provider/legacyZCodeConfigProviderReader.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
import { createProviderModelCatalogLister } from "./model-provider/providerModelCatalog.js";
import {
  createProviderProvisioningSource,
  type ProviderProvisioningSource,
} from "./model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "./model-provider/providerProvisioningTarget.js";
import { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
import { createUsageStatsService } from "./usage-stats/usageStatsService.js";
import { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
import { createClientConfigService } from "./client-config/clientConfigService.js";
import { IClientConfigService } from "./client-config/clientConfig.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
import { createPluginsService } from "./plugins/pluginsService.js";
import { createPluginManagementService } from "./plugins/pluginManagementService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createNodeApiClient } from "./providers/api/nodeApiClient.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRuntimeEnv,
} from "./runtime-tools/agentProxyEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ICuaPermissionService,
  type CuaPermissionRestartOptions,
  type CuaPermissionRestartResult,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
} from "#src/cua-permission-broker/index.js";
import {
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
  type WindowsCuaRuntime,
} from "#src/cua-permission-broker/windowsCuaDevRuntime.js";
import { WindowsCuaHelperHost } from "#src/cua-permission-broker/windowsCuaDevHelperHost.js";
// Computer Use 权限状态改由 cua-driver 的 check_permissions 提供（见 platform.js 的装配）。
import { assembleCuaPermissionServiceAsync } from "@zcode/zcode-cua/platform";
// Helper 传输层仅存的符号：broker socket / 启动 rendezvous / 生命周期协调 / Helper host 类型。
// macOS 的闭源 Helper 已整体拆除，这些是 Windows 自研 Helper host 仍在用的部分。
import {
  BROKER_SOCKET_ENV,
  BROKER_UNAVAILABLE_ENV,
  createCuaProductMcpServerResolver,
  CuaHelperLifecycleManager,
  CuaProductHelperWorkspaceRegistry,
  isCuaHelperError,
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialZCodeCuaAgentMcpServer,
  resolveBrokerSocketPath,
  waitForCuaHelperStartup,
  type CuaHelperHost,
  type CuaHelperTransportHandle,
  type CuaHelperTransportRestartOptions,
  type CuaHelperTransportRestartResult,
  type ManagedCuaProductHelperHost,
  type CuaProductMcpServerResolver,
  type CuaProductMcpServerResolverContext,
} from "@zcode/zcode-cua/helper-transport";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  formatLogPrefix,
  type ServiceAuthorityMode,
  resolveRuntimeZCodeEndpointOrigin,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  isZCodeCuaInternalFeatureEnabled,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@zcode/shared";

// 这些 conversation-share 实现依赖 Node 文件系统；仅通过 @zcode/services/node 暴露，
// 防止 browser-safe 根入口把 node:* 依赖带进 renderer。
export { ConversationShareService, conversationShareConnectionScopeFactory };

interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

const CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS = 30_000;
// Cold-start budget: the Helper's first cold launch (large Node SEA + first-time Gatekeeper/notarization
// 有界 spawn grace：给正常的签名 Helper 冷启动一个短暂但现实的就绪窗口。实机上
// Gatekeeper + SEA 启动通常需要 300–500ms，旧 250ms 会把健康首启误判为 BROKER_UNAVAILABLE。
// 1s 后仍未就绪才 fail-closed，后台 startup 继续收敛；不会等待完整的 30s health budget。
// helper 随后 ready 时由 reconcileRecoveredHelper 只清理后续 spawn admission marker，绝不触碰
// 已有 Agent。绝不照搬 feat 的 10s caller wait。
const CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS = 1_000;

type DefaultCuaProductHelper = {
  host: ManagedCuaProductHelperHost;
  macPermissionHost?: CuaHelperHost;
  resolver: CuaProductMcpServerResolver;
};

type ManagedDefaultCuaProductHelper = {
  helper: DefaultCuaProductHelper;
  seedContext?: CuaProductMcpServerResolverContext;
};

const cuaProductHelperAgentEnvRetryAt = new WeakMap<Pick<CuaHelperHost, "start">, number>();
const cuaProductHelperTrackedStart = new WeakMap<Pick<CuaHelperHost, "start">, Promise<unknown>>();
/**
 * 本次 startup 期间有 agent 消费过 reservation（拿了 Helper 尚未就绪时预留的 tuple）。
 *
 * 撤销路径不可省：那些 spawn 是**成功返回**的，从未进过 catch，所以 startup 最终失败时
 * 没有任何既有机制会把它们标记为需要重新 spawn。这里补上 mark，让后续 spawn 在 Helper
 * 不可用时继续 fail-closed；Helper ready 后只清理 marker，不回收已有 Agent。
 */
const cuaProductHelperReservedSpawns = new WeakSet<Pick<CuaHelperHost, "start">>();
/** Agent 已消费 Windows transport_ready tuple；full startup 后续失败时仍保留既有 Agent。 */
const cuaProductHelperTransportSpawns = new WeakSet<Pick<CuaHelperHost, "start">>();

function trackCuaProductHelperStartup(
  host: Pick<CuaHelperHost, "start">,
  startup: Promise<unknown>,
): void {
  if (cuaProductHelperTrackedStart.get(host) === startup) return;
  cuaProductHelperTrackedStart.set(host, startup);
  void startup.then(
    () => {
      cuaProductHelperAgentEnvRetryAt.delete(host);
      cuaProductHelperReservedSpawns.delete(host);
      cuaProductHelperTransportSpawns.delete(host);
      if (cuaProductHelperTrackedStart.get(host) === startup) {
        cuaProductHelperTrackedStart.delete(host);
      }
    },
    () => {
      // The caller may already have timed out while the shared 30s startup continued. Its eventual
      // failure must still establish backoff; otherwise every new task immediately repeats install/
      // launch/health work during a persistent failure.
      cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS);
      // 有 Agent 拿着预留/transport tuple 而 Helper 最终没起来 → 退避只收敛后续 spawn，
      // 不反向销毁已有 Agent（unavailable marker 已随闭源 Helper 一并删除）。
      cuaProductHelperReservedSpawns.delete(host);
      cuaProductHelperTransportSpawns.delete(host);
      if (cuaProductHelperTrackedStart.get(host) === startup) {
        cuaProductHelperTrackedStart.delete(host);
      }
    },
  );
}

function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

interface ManagedCuaHelperHostDispose {
  stop(): Promise<void>;
}

// 默认 Computer Use Helper 是长生命周期的独立 TCC 授权进程（持 broker socket + Accessibility/Screen Recording）。
// 它不是 IPC 服务，不进 ServiceCollection 的 disposeAll 列表，但 host 释放时必须显式终止它，否则会以
// 已授权主体常驻、甚至在 services 重建时再起一个 → 多实例/孤儿/权限主体泄漏。用与 ServiceCollection 绑定
// 的 WeakMap 侧表登记，dispose 时统一终止（best-effort，不阻断其它资源回收）。
const managedCuaHelperHosts = new WeakMap<ServiceCollection, ManagedCuaHelperHostDispose>();
const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
const providerProvisioningSources = new WeakMap<ServiceCollection, ProviderProvisioningSource>();
const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// TaskIndexRepo 等各自持有 tasks-index.sqlite 的连接句柄；
// dispose 链必须统一关闭：Windows 上句柄悬着会让宿主回收后临时目录 rm 撞 EBUSY
// （stdioDesktopPresentationSurface 单测稳定复现），Linux 的 unlink-while-open 语义掩盖了泄漏。
// 与其它侧表一样按 ServiceCollection 登记并在 dispose 时统一 close。
const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();
/** Local Host 进程内的 Provisioning Source；不会把凭据通过通用 RPC 暴露给 Renderer。 */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

const managedHostApiNetworkTransports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();
// AstrBot 桥接的传输控制面（beginTurn/settleTurn/resolveResume/buildSnapshot/
// ackDeliveryByFrameId）只服务于 host 内部的 loopback WS 传输，不是业务契约。
// 修复依据：原先把 IAstrBotBridgeService register 进 ServiceCollection，
// exposeOnChannelServer() 会把它连同这些内部控制方法一起暴露给 MessagePort 客户端
//（桌面渲染进程 / 手机远控），内部传输控制面就成了 RPC 面。
// 改用与 managedCuaHelperHosts / providerRuntimes 相同的 WeakMap 侧表，
// host 经专用 getter 取用，不进入通用 RPC Channel。
const astrBotBridgeProviders = new WeakMap<ServiceCollection, AstrBotProvider>();

export function registerManagedCuaHelperHostForDispose(
  services: ServiceCollection,
  host: ManagedCuaHelperHostDispose,
): void {
  managedCuaHelperHosts.set(services, host);
}

/** AstrBot 桥接传输控制面；host 专用，不随 ServiceCollection 暴露到 RPC。 */
export function getAstrBotBridgeProvider(services: ServiceCollection): AstrBotProvider | undefined {
  return astrBotBridgeProviders.get(services);
}

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

export function shouldEnableDefaultCuaProductHelper(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  // CUA 已随正式版默认开启（isZCodeCuaInternalFeatureEnabled 默认 ON，仅显式 0/false/off 关闭；2026-08 注释更正——旧注释称默认关闭已过期）。显式开启后 macOS 使用既有产品 Helper，Windows 使用安装包内 runtime；
  // 两端都保持按需启动。关闭时不创建 host、不探测资源、不产生子进程或权限提示。
  const env = options.env ?? process.env;
  if (!isZCodeCuaInternalFeatureEnabled(env)) return false;
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "win32";
}

/**
 * 是否在当前 host 创建默认 CUA product Helper。Computer Use Helper 只能由**桌面本地** authority 创建：
 * - desktop-attached-remote 与 standalone-server 都绝不自动创建，避免远端 workspace 在错误的
 *   host 上启动 Helper，破坏 shared-host attachment 与权限边界；
 * - 已显式注入 resolver 时不重复创建。
 * 平台/环境层面的启用与否另由 shouldEnableDefaultCuaProductHelper 决定。
 */
export function shouldCreateDefaultCuaProductHelper(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasRemoteWorkspaceIdentity?: boolean;
  hasInjectedResolver: boolean;
  hasBuiltInCuaPlugin: boolean;
}): boolean {
  return (
    opts.hasBuiltInCuaPlugin &&
    opts.serviceAuthorityMode === "desktop-local" &&
    !opts.hasRemoteWorkspaceIdentity &&
    !opts.hasInjectedResolver
  );
}

export function shouldUseCuaPermissionService(opts: {
  platform?: NodeJS.Platform;
  cuaEnabled: boolean;
}): boolean {
  return (opts.platform ?? process.platform) === "darwin" && opts.cuaEnabled;
}

export function shouldRetainDefaultCuaProductHelper(): boolean {
  // CUA 开关只门控后续 Agent admission；已创建的 Helper 只在 Host/App dispose 时停止。
  return true;
}

export function shouldEnableCuaOperationStateReporter(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasReporter: boolean;
}): boolean {
  // CUA 操作状态属于物理桌面投影；远端 workspace/server 不得把自己的 turn 投影到本机屏幕。
  return opts.hasReporter && opts.serviceAuthorityMode === "desktop-local";
}

export function createDynamicCuaProductMcpServerResolver(options: {
  isPluginEnabled: (context?: CuaProductMcpServerResolverContext) => boolean;
  getResolver: (
    context?: CuaProductMcpServerResolverContext,
  ) => CuaProductMcpServerResolver | undefined | Promise<CuaProductMcpServerResolver | undefined>;
  isResolverCurrent?: (
    resolver: CuaProductMcpServerResolver,
    context?: CuaProductMcpServerResolverContext,
  ) => boolean;
}): CuaProductMcpServerResolver {
  return {
    async resolveMcpServers(servers, context) {
      if (!options.isPluginEnabled(context)) return servers;
      const resolver = await options.getResolver(context);
      if (!resolver) return servers;
      const resolved = await resolver.resolveMcpServers(servers, context);
      // delegate 可能跨过 Helper start/health await；dispose 在等待中置 terminal 时，不能把旧代际
      // 刚注入的 socket/token 交给晚到 Agent。移除 CUA candidate，保持其它 MCP 原样。
      return options.isResolverCurrent?.(resolver, context) === false
        ? servers?.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server))
        : resolved;
    },
    async restart() {
      // 委托到底层真实 resolver（由 ICuaPermissionService.restartHelper 经此调用）。
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restart();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      // 授权完成后的 restart 必须保留 session id，才能复用底层的幂等与时序保障。
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restartAfterPermissionGrant(onboardingSessionId);
    },
  };
}

type CreateDefaultCuaProductHelperOptions = {
  // 转发给 resolver，restart 前用来判断是否有活跃 turn（见 cuaProductMcpResolver.ts）。
  // desktop-local agent service 会提供真实的 CUA turn 状态；其他调用方没有该状态时才回退为 false。
  hasActiveTurn?: () => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  resolveWindowsRuntime?: () => Promise<WindowsCuaRuntime>;
  createMacHost?: () => CuaHelperHost;
  createWindowsHost?: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
};

/**
 * Windows 侧 Helper 宿主的懒解析包装：把「解析安装包运行时」推迟到首次 start()/checkHealth()，
 * 并把解析结果缓存（含 rejection）。
 *
 * resolveWindowsCuaRuntime 可能因 missing-native-addon、artifact-integrity-mismatch、
 * incompatible-runtime-manifest 等原因失败。若只向调用方抛错而没有诊断记录，设置页的
 * 「未加载」状态无法说明具体原因。因此在这里记录一条带 reason 的
 * error 日志，且因为 rejection 被缓存、日志挂在同一条 promise 链上，重复 start() 不会刷屏。
 * 载荷只有 reason/artifact/errorName/message：解析发生在 mint token 与命名管道之前，天然不含密钥。
 */
export function createWindowsCuaHelperHost(options: {
  resolveRuntime: () => Promise<WindowsCuaRuntime>;
  createHost: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
  logger?: ServiceLogger;
}): ManagedCuaProductHelperHost {
  let host: ManagedCuaProductHelperHost | undefined;
  let resolving: Promise<ManagedCuaProductHelperHost> | undefined;
  let stopped = false;
  let lifecycleEpoch = 0;
  let stopDrain: Promise<void> | undefined;
  const logResolutionFailure = (error: unknown): void => {
    if (!options.logger) return;
    const resolutionError =
      error instanceof WindowsCuaDevRuntimeResolutionError ? error : undefined;
    const artifact = resolutionError?.artifact;
    options.logger.error(undefined, "Windows CUA Helper runtime resolution failed", {
      reason: resolutionError?.reason ?? "unknown",
      ...(artifact ? { artifact } : {}),
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const assertActive = (epoch: number): void => {
    if (stopped || epoch !== lifecycleEpoch) {
      throw new Error("Windows Computer Use Helper startup stopped");
    }
  };
  const getHost = async (epoch: number): Promise<ManagedCuaProductHelperHost> => {
    assertActive(epoch);
    if (host) return host;
    resolving ??= options
      .resolveRuntime()
      // catch 只包住 resolveRuntime 本身：下面 then 里的 assertActive 抛出是 stop() 竞态，不是解析失败，
      // 不能混进同一条诊断日志。
      .catch((error: unknown) => {
        logResolutionFailure(error);
        throw error;
      })
      .then((runtime) => {
        // stop() 会同步推进 epoch。运行时解析完成后必须再次检查，防止 dispose 返回后才构造并启动孤儿 Helper。
        assertActive(epoch);
        const nextHost = options.createHost(runtime);
        assertActive(epoch);
        host = nextHost;
        return nextHost;
      });
    const resolvedHost = await resolving;
    assertActive(epoch);
    return resolvedHost;
  };
  const withActiveHost = async <T>(
    operation: (activeHost: ManagedCuaProductHelperHost) => Promise<T>,
  ): Promise<T> => {
    const epoch = lifecycleEpoch;
    const activeHost = await getHost(epoch);
    assertActive(epoch);
    return operation(activeHost);
  };
  return {
    get running() {
      return host?.running ?? false;
    },
    get socketPath() {
      return host?.socketPath ?? null;
    },
    get pluginAuthority() {
      return host?.pluginAuthority ?? null;
    },
    async start() {
      return withActiveHost((activeHost) => activeHost.start());
    },
    async checkHealth(timeoutMs?: number) {
      return withActiveHost((activeHost) => activeHost.checkHealth(timeoutMs));
    },
    async waitForTransport(timeoutMs?: number) {
      return withActiveHost((activeHost) => {
        if (!activeHost.waitForTransport) {
          // 兼容旧注入 Host：没有两阶段接口时，完整 start handle 就是唯一可用 tuple。
          return activeHost.start().then((handle) => ({
            socketPath: handle.socketPath,
            pluginAuthority: handle.pluginAuthority,
          }));
        }
        return activeHost.waitForTransport(timeoutMs);
      });
    },
    async restart() {
      return withActiveHost((activeHost) => activeHost.restart());
    },
    async restartAfterCurrentStart() {
      return withActiveHost((activeHost) => activeHost.restartAfterCurrentStart());
    },
    async restartAfterCurrentStartPreservingTransport(
      restartOptions?: CuaHelperTransportRestartOptions,
    ): Promise<CuaHelperTransportRestartResult> {
      return withActiveHost((activeHost) => {
        if (activeHost.restartAfterCurrentStartPreservingTransport) {
          return activeHost.restartAfterCurrentStartPreservingTransport(restartOptions);
        }
        // 兼容旧注入 Host：wrapper 一旦暴露 preserving 接口，就必须代为提交 fresh-start
        // marker；否则 producer 会在新 tuple 已启动后判定 fail-closed 契约被破坏。
        restartOptions?.beforeFreshStart?.();
        return activeHost.restartAfterCurrentStart().then((handle) => ({ handle, reused: false }));
      });
    },
    async stop() {
      if (stopDrain) return stopDrain;
      stopped = true;
      lifecycleEpoch += 1;
      const pendingResolution = resolving;
      stopDrain = (async () => {
        // 等待已开始的解析落定，确保它观察到 terminal epoch；否则 dispose 之后仍可能晚到地启动 Helper。
        await pendingResolution?.catch(() => undefined);
        await host?.stop();
      })();
      return stopDrain;
    },
  };
}

export function createDefaultCuaProductHelper(
  options: CreateDefaultCuaProductHelperOptions,
): DefaultCuaProductHelper | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!shouldEnableDefaultCuaProductHelper({ platform, env })) {
    return undefined;
  }
  const logger = createServiceLogger("cua-product-helper");
  // macOS 的闭源 `ZCode Computer Use.app` 已整体拆除：权限走 cua-driver
  // （@zcode/zcode-cua/permissions），输入/观测走 cua-driver 原生 SDK。
  // 这里只剩 Windows 自研 Helper host 一条分支。
  const host: ManagedCuaProductHelperHost = createWindowsCuaHelperHost({
    resolveRuntime:
      options.resolveWindowsRuntime ??
      (() =>
        resolveWindowsCuaRuntime({
          platform,
          env,
          resourcesPath: options.resourcesPath,
          arch: options.arch,
          electronVersion: options.electronVersion,
        })),
    createHost:
      options.createWindowsHost ??
      ((runtime) =>
        new WindowsCuaHelperHost({
          runtime,
          logger,
        })),
    logger,
  });
  const resolver = createCuaProductMcpServerResolver(host, {
    hasActiveTurn: options.hasActiveTurn,
  });
  return { host, resolver };
}

export function hasGlobalCliZCodeCuaServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.HOME?.trim() || homedir();
  const configPath = join(home, ZCODE_USER_DATA_DIR_NAME, "cli", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (isRecord(parsed.features) && parsed.features.mcp === false) return false;
  if (!isRecord(parsed.mcp) || !isRecord(parsed.mcp.servers)) return false;
  return Object.entries(parsed.mcp.servers).some(([name, config]) =>
    isGlobalCliZCodeCuaServer(name, config),
  );
}

function isGlobalCliZCodeCuaServer(name: string, config: unknown): boolean {
  if (!isRecord(config)) return false;
  if (config.enabled === false) return false;
  if (typeof config.type === "string" && config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // 与 desktop/services resolver 和 CLI bootstrap 共用 @zcode/shared 的单一事实源，避免第三处
  // 判定漂移：git/.git/本地路径形态的 zcode-cua 若这里漏判，全局 CLI env 注入不会带 broker
  // socket/token，agent 会回退成 Python/uvx 自己持有 macOS TCC（违反 product broker 边界）。
  if (typeof config.command === "string" && isZCodeCuaMcpCommand(config.command)) {
    return true;
  }
  return (
    Array.isArray(config.args) &&
    config.args.some((arg) => typeof arg === "string" && isZCodeCuaMcpPackageArg(arg))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function buildCuaProductHelperAgentEnv(
  host:
    | (Pick<CuaHelperHost, "start"> &
        Partial<
          Pick<CuaHelperHost, "running" | "checkHealth" | "reservedTransport"> & {
            waitForTransport(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
          }
        >)
    | undefined,
  logger = createServiceLogger("cua-product-helper"),
): Promise<Record<string, string>> {
  if (!host) return {};
  const retryAt = cuaProductHelperAgentEnvRetryAt.get(host);
  // 非阻塞设计（用户硬约束）：spawn 绝不卡在冷启动上。warm helper（host.running）走快速
  // checkHealth（1s 上限，健康 helper 毫秒级返回；只有病态 helper 才吃满，可接受）；cold helper
  // 已有安全预留时立即返回，否则走有界 1s deadline race，超时且无预留才 fail-closed 到
  // BROKER_UNAVAILABLE，后台共享 startup 继续收敛。resolver 会在后续 request boundary
  // 只收敛后续 spawn admission；
  // 绝不从后台 completion 异步打断首个 session，也绝不让 spawn 等 10s。
  //
  // fail-closed 理由：CLI 全局配置里存在 zcode-cua 时，返回空 env 会让 agent 按原始
  // 无 broker 凭据启动 MCP 子进程会绕过已获授权的 Helper broker，让 Python
  // MCP 成为实际 TCC 执行主体。broker 未就绪时必须返回 BROKER_UNAVAILABLE，绝不返回空 env。
  try {
    if (host.running && host.checkHealth) {
      // start() intentionally returns an existing handle without probing. Never spawn a new agent
      // with a dead Helper's stale tuple; the session resolver owns on-demand Helper restart,
      // while this lower-level spawn path fails closed until that recovery completes.
      await host.checkHealth(1000);
      cuaProductHelperAgentEnvRetryAt.delete(host);
    } else if (retryAt && Date.now() < retryAt) {
      return {
        [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper startup retry is deferred",
      };
    }
    const startup = host.start();
    trackCuaProductHelperStartup(host, startup);
    if (host.waitForTransport) {
      // Windows named pipes cannot reserve/rename a final socket. The Helper sends
      // transport_ready once the pipe is bound; use that tuple while full health
      // (native/UIA initialization) continues in the shared startup promise.
      const transport = await waitForCuaHelperStartup(
        host.waitForTransport(CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS),
        CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS,
      );
      cuaProductHelperTransportSpawns.add(host);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      return {
        [BROKER_SOCKET_ENV]: transport.socketPath,
        [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: transport.pluginAuthority,
      };
    }
    // 原来只在 1s 超时后读取预留 tuple，Host 已安全占住 socket 时也会白等。
    // 复用原准入条件提前返回；完整 startup 的失败仍由上面的 tracker 收敛。
    const reserved = host.reservedTransport;
    if (reserved) {
      cuaProductHelperReservedSpawns.add(host);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      // 这条 reserved 分支不再下发 BROKER_TOKEN_ENV：broker
      // token 鉴权已整体删除（连接门是代码签名身份）。凭据只剩 socket + authority。
      return {
        [BROKER_SOCKET_ENV]: reserved.socketPath,
        [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: reserved.pluginAuthority,
      };
    }
    // 有界 deadline race：cold launch 没在 1s 内 ready 且无预留才 fail-closed。waitForCuaHelperStartup
    // 超时抛 caller_timeout（被下面 catch 当作"后台仍在跑"，不额外设 retryAt）。
    const handle = await waitForCuaHelperStartup(
      startup,
      CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS,
    );
    cuaProductHelperAgentEnvRetryAt.delete(host);
    return {
      [BROKER_SOCKET_ENV]: handle.socketPath,
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: handle.pluginAuthority,
    };
  } catch (error) {
    // caller_timeout 仅表示共享的 30s startup 仍在后台运行；trackCuaProductHelperStartup 会在其
    // 真正失败时建立 backoff。这里提前退避会让已经 ready 的 Helper 仍被后续 Agent 错误禁用。
    const isCallerTimeout = isCuaHelperError(error) && error.code === "caller_timeout";
    if (isCallerTimeout) {
      // 冷启动 rendezvous：Helper 还在起，但 host 已经占住 final socket 并预留了 tuple。
      // 此时下发的凭据是**可用**的——final 上是 host 占位，未验签的 Helper 绑在 .pending
      // 上够不到它；client 连上占位会被立刻 destroy 并按 broker_unavailable 退避重试，
      // Helper 验证通过后 host 原子 rename 让渡，重试自然落到真 Helper 上。
      //
      // 这条分支存在的意义：Helper 未 ready 时只拒绝本次 Agent 的 CUA MCP admission；
      // Helper ready 后仍只影响后续 Agent spawn，不能通过 lifecycle 操作连带冲掉已有会话。
      const reserved = host.reservedTransport;
      if (reserved) {
        cuaProductHelperReservedSpawns.add(host);
        cuaProductHelperAgentEnvRetryAt.delete(host);
        return {
          [BROKER_SOCKET_ENV]: reserved.socketPath,
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: reserved.pluginAuthority,
        };
      }
    }
    if (!isCallerTimeout) {
      cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS);
    }
    logger.warn(
      undefined,
      `Computer Use Helper broker_unavailable; disabling workspace zcode-cua MCP server for this agent spawn (${cuaHelperStartErrorDetail(error)})`,
    );
    return {
      [BROKER_UNAVAILABLE_ENV]: isCallerTimeout
        ? // 冷启动仍在后台跑——"warming up"，reconcileRecoveredHelper 会在 helper ready 后
          // 只清理后续 spawn marker。
          "broker_unavailable: helper broker warming up"
        : `broker_unavailable: ${cuaHelperStartErrorDetail(error)}`,
    };
  }
}

function cuaHelperStartErrorDetail(error: unknown): string {
  return isCuaHelperError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * 创建包含所有本地服务的 ServiceCollection
 *
 * @param options.parentPort - Electron host process 的 parentPort，
 *        用于 BroadcastService 跨窗口中转。传 null 则广播为空操作。
 */
export function createLocalServices(options: {
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Host 装配层注入的设置权威；与网络 transport 必须来自同一 Window Host 生命周期。 */
  settingService?: ISettingService;
  /** 注入后由 ServiceCollection 接管释放，并供 Host 其它 app-managed 下载复用。 */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** workspace 文件搜索默认使用内置过滤器；后续规则来源只需在 Host 装配时注入最终实现。 */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** desktop local host 在 manual run 落库后直接派发，不经过 scheduler 正常路径。 */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  // 注入点：默认 resolver 已能覆盖 dev/桌面/SSH 远端三类形态；
  // 测试或特殊宿主想强制走自定义 binary/参数时从这里注入。
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Desktop Main 提前异步采集的本机 runtime 环境；Local Host 注入后不再同步启动 login shell。 */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** 本地桌面上次 workspace 缺失时，仅用于 Agent 子进程 spawn.cwd 兜底。 */
  zcodeAgentSpawnFallbackCwd?: string;
  /** desktop-attached remote server 从 Desktop Host 收到的一次性 Agent 网络配置。 */
  remoteAgentNetwork?: {
    httpProxy?: string;
    noProxy?: string;
  };
  /** 所属 Environment 的 ZCode Built-in Provider Config 物理路径。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** HTTP Server 只有在调用方明确配置认证时才暴露跨 Environment Provisioning target。 */
  providerProvisioningTargetEnabled?: boolean;
  /** Desktop Host 私有通知；只在 Source 成功持久化后请求 Main 调度远端镜像。 */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
  agentRuntimeContext?: {
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
  /** browser-use 执行桥（host→main WebContentsView+CDP）；desktop host 注入，缺省则 browser 不可用。 */
  browserControlExecutor?: {
    list(input: {
      requestId: string;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
    }): Promise<BrowserBackendDescriptor[]>;
    execute(input: {
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
      command: BrowserCommand;
    }): Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  /** Windows desktop-local Host 的 CUA turn 状态投影；其它 authority 会在装配层拒绝。 */
  cuaOperationStateReporter?: CuaOperationStateReporter;
}): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  // host / remote server 以前直接沿用当前进程环境启动后续服务。
  // GUI 启动的 desktop、SSH/WSL/Docker 拉起的 remote server 往往拿不到用户 login shell 里的 PATH，
  // 导致 bun 这类只在 shell profile 里追加的命令在 ZCode Agent/终端里不可见。
  // 这里在所有本地服务启动前统一修正运行时环境，并顺带把内置 rg 注入 PATH，
  // 让 ZCode Agent、终端、认证 runtime 共用同一套命令解析结果。
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

  const desktopContextPromptEnabledRaw =
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;

  // app 自签 CA：首次启动生成一份根 CA（幂等），供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任、
  // 出口代理用其私钥重签。生成失败不应阻断启动（例如只读文件系统），仅记录日志后继续。
  try {
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

  const settingService = createObservableSettingService(
    options?.settingService ?? createSettingService(),
  );
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });
  const credentialService = createCredentialService();
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
  const gitCheckpointService = createGitCheckpointService();
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  const systemService = createSystemService();
  // 任务列表与 session syncer 共用全局 tasks-index；repo 懒加载数据库，构造不增加启动 I/O。
  const taskIndexRepo = new TaskIndexRepo();
  const onboardingRecordService = createOnboardingRecordService();
  const providerConfigLog = createServiceLogger("provider-config");
  const providerConfigRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: options.zcodeBuiltinProviderConfigFilePath,
    onConfigCheckError: (error) => {
      providerConfigLog.warn(undefined, "Provider Config 依赖恢复失败，将继续重试", { error });
    },
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal Provider Config 加载失败，已保留磁盘状态并以内存空配置降级",
        {
          error: event.error,
        },
      );
    },
    onPersonalConfigPollingError: (error) => {
      // 轮询错误只在进入失败状态时回调一次；下一轮仍会自行重试，避免持续故障刷盘。
      providerConfigLog.warn(undefined, "Personal Provider Config 轮询暂时失败，将继续重试", {
        error,
      });
    },
    // 已发布 config.json 保存的是 ZCode 用户配置；清理第三方 ACP 不能移除这条升级路径。
    // Repository 仅在新 Personal 配置不存在时导入，并保留旧文件以便回滚。
    readLegacyProviders: () => readLegacyZCodeConfigProviders(),
  });
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  });
  const providerProvisioningDisposers = [
    providerConfigRuntime.configService.onDidChange((reason) => {
      // 每个 Window Host 都会轮询同一文件；只把本进程成功提交的 updated
      // 作为同步触发，避免其它 Host 的 poll-changed 把一次保存重复计入多个代际。
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
  ];
  let providerConnectivityAgentService:
    | Pick<IZCodeAgentService, "testModelConnectivity">
    | undefined;
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型连通性测试装配");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    // 自定义 Provider 的模型目录读取走宿主 ApiClient（代理/超时/ZCode 端点判定复用同一出口）。
    modelCatalog: createProviderModelCatalogLister({ apiClient }),
  });
  // mcpSync/hooks 里引用 zcodeAgentService 的闭包是惰性调用，声明顺序不影响初始化。
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const mcpSyncService = createMcpSyncService({
    // mcp/list 的 host 消费点收拢到 mcpSync 服务；真实状态检查仍在 agent 进程。
    listMcpServerStatuses: (params) => zcodeAgentService.listMcpServerStatuses(params),
  });
  const pluginSyncService = createPluginSyncService();
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const commandsService = createCommandsService({ isDesktopRuntime: true });
  const hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
  });
  const memoryService = createMemoryService();
  // 只要当前进程已经装配 Provider Runtime，就由该 Environment 自己的 Selection View
  // 决定执行就绪状态。Desktop-attached remote 也读取远端自己的本地模型配置。
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  // ===== Computer Use Helper lifecycle 层（port 自 feat）=====
  // 根因修复：app 启动时预 spawn 的 agent 早于 broker ready → buildCuaProductHelperAgentEnv 在
  // 1s grace 内拿不到 ready helper → 返回 BROKER_UNAVAILABLE → 那些 agent 的 computer-use MCP
  // server fail-closed。之后开对话复用这些 Agent 时，Helper lifecycle 不得触发 Agent 重建。
  // 约束：① 有界 spawn grace（1s 后 fail-closed，不等待完整 health budget）；② lifecycle coordinator 懒获取 +
  // 代际 fence（dispose 仅来自显式 workspace 生命周期）；③ 不创建定时健康探测，checkHealth 只在
  // CUA spawn/resolve 等按需边界执行；④ Helper restart 尽可能复用 host transport，既有 Agent
  // 的 session、进程与 MCP stream 保持不变。
  const cuaProductHelperWorkspaceRegistry = new CuaProductHelperWorkspaceRegistry();
  // createDefaultCuaProductHelper() 在 zcodeAgentService 存在之前就要组装 resolver，
  // 但"是否有活跃 turn"这个信号只有 zcodeAgentService 建好之后才能查询。用前向引用占位——resolver 真正
  // 调用 hasActiveTurn() 发生在后续某次 resolveMcpServers（异步），那时 hasActiveTurnRef 早已被赋值。
  // 先用前向引用连接 agent service 的 CUA turn tracker，避免在活跃 CUA 请求中途重启 Helper；
  // service 创建完成后再赋值。Helper recovery 始终不能回收 Agent。
  let hasActiveTurnRef: (() => boolean) | undefined;
  const isCuaEnabledForContext = (context?: CuaProductMcpServerResolverContext): boolean =>
    // 保留 main 原有 gate 行为（避免回归）：dev/internal 特性开启时（ZCODE_CUA_DEV_MODE=1 或
    // ZCODE_CUA_PRODUCT_HELPER=1）即视为启用，不依赖 config.json 显式 enable——main 的 bootstrap
    // 用 isZCodeCuaInternalFeatureEnabled 门控 bundled plugin，与 feat 的 workspace enablement 不同。
    // 生产路径（dev mode off）回落到官方插件 workspace enablement 判定（与 feat 一致）。
    isZCodeCuaInternalFeatureEnabled(process.env) ||
    isOfficialCuaPluginEnabledForWorkspace({
      env: process.env,
      workingDirectory: context?.workspacePath,
    });
  const defaultCuaProductHelperLifecycle =
    new CuaHelperLifecycleManager<ManagedDefaultCuaProductHelper>(async (managed) => {
      await managed.helper.host.stop();
    });
  const createManagedDefaultCuaProductHelper = (
    context?: CuaProductMcpServerResolverContext,
  ): ManagedDefaultCuaProductHelper | undefined => {
    const helper = createDefaultCuaProductHelper({
      // 转发活跃-turn 查询（前向引用，zcodeAgentService 建好后赋值）。
      hasActiveTurn: () => hasActiveTurnRef?.() ?? false,
    });
    if (!helper) return undefined;

    // 历史默认装配启动 10 秒周期 watchdog；空闲期一次 broker_info 超时就会在后台
    // 调用 resolver.restart()。Helper 不是 Agent runtime owner，且无需在没有 CUA 需求时自愈；
    // 健康检查保留在 spawn env / resolver request boundary，避免后台 timer 干扰其他模块。
    return {
      helper,
      ...(context ? { seedContext: context } : {}),
    };
  };
  const getOrCreateDefaultCuaProductHelper = async (
    context?: CuaProductMcpServerResolverContext,
  ): Promise<DefaultCuaProductHelper | undefined> => {
    const managed = await defaultCuaProductHelperLifecycle.acquire({
      isAdmitted: () =>
        shouldCreateDefaultCuaProductHelper({
          serviceAuthorityMode: options?.serviceAuthorityMode,
          hasRemoteWorkspaceIdentity: Boolean(context?.workspaceIdentity?.trim()),
          hasInjectedResolver: Boolean(options?.cuaProductMcpServerResolver),
          hasBuiltInCuaPlugin: isCuaEnabledForContext(context),
        }),
      shouldRetainCurrent: shouldRetainDefaultCuaProductHelper,
      create: () => createManagedDefaultCuaProductHelper(context),
    });
    return managed?.helper;
  };
  const isDefaultCuaProductHelperCurrent = (helper: DefaultCuaProductHelper): boolean =>
    defaultCuaProductHelperLifecycle.peek()?.helper === helper;
  // Computer Use 权限状态改由 cua-driver 的 check_permissions 提供，取代闭源 Helper 的
  // permission_status broker 调用。读权限标志不需要 TCC，所以在宿主进程里查询是安全的；
  // 「申请授权」必须由 Electron main 经 @zcode/zcode-cua/macos-permissions 触发，
  // 这样 TCC 弹窗归属 ZCode.app 而不是本宿主进程。
  // cua-driver 没有可重启的常驻 Helper：授权改由系统设置面板处理，restartHelper 只回报成功，
  // 让 UI 收起引导而不影响任何既有 Agent。
  let cuaDriverPermissionService: ICuaPermissionService | undefined;
  const getCuaDriverPermissionService = async (): Promise<ICuaPermissionService> => {
    // 原生库加载一次就够：client 长期持有，避免每次设置页刷新都重载几十 MB 的 .so/.dylib。
    cuaDriverPermissionService ??= await assembleCuaPermissionServiceAsync({
      platform: process.platform,
      env: process.env,
    });
    return cuaDriverPermissionService;
  };
  const cuaPermissionService: ICuaPermissionService = {
    async getStatus(
      workspacePath: string,
      workspaceIdentity?: string,
      queryOptions?: CuaPermissionStatusQueryOptions,
    ): Promise<CuaPermissionStatusResult> {
      if (process.platform !== "darwin") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 插件关闭只门控后续 Agent；权限页刷新不得触碰运行时，避免设置页操作影响已有 Agent。
      if (!shouldUseCuaPermissionService({ cuaEnabled: isCuaEnabledForContext(context) })) {
        return {
          available: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      try {
        const service = await getCuaDriverPermissionService();
        return await service.getStatus(workspacePath, workspaceIdentity, queryOptions);
      } catch (error) {
        return {
          available: false,
          reason: `Could not read Computer Use permission status: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    async restartHelper(
      _workspacePath: string,
      _workspaceIdentity?: string,
      _restartOptions?: CuaPermissionRestartOptions,
    ): Promise<CuaPermissionRestartResult> {
      // cua-driver 无常驻 Helper 可重启；授权由系统设置面板处理。保留方法以维持
      // ICuaPermissionService 契约（UI 仍在调用），语义降级为 no-op 成功。
      return { ok: true };
    },
  };
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({ apiClient });
  const zcodeAgentService = createZCodeAgentService({
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    // 动态工作流灰度：
    // 这里不按 serviceAuthorityMode 裁剪——SSH/WSL/Docker 的 desktop-attached-remote Host
    // 是它自己那些 workspace 的唯一裁决者，灰度开启时远程 workspace 同样提供工作流。
    resolveDynamicWorkflowClientConfig: () =>
      codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentRuntimeContext?.runtimeSurface,
      serviceAuthorityMode: options?.serviceAuthorityMode,
      desktopContextPromptEnabled,
    }),
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // createLocalServices 虽然暴露了 reporter 注入点，旧装配却没有继续传给
    // ZCodeAgentProcessManager，导致 host 永远不向 main 上报 Agent spawn/exit，进程监控器
    // 因而看不到实际运行的 Agent，也无法验证只读到可写升级是否复用同一进程。
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.zcodeAgentSpawnFallbackCwd,
    // browser-use：host→main 执行桥透传给 agent service 的 onRequest browserExecute 路由。
    browserControlExecutor: options?.browserControlExecutor,
    cuaOperationStateReporter: shouldEnableCuaOperationStateReporter({
      serviceAuthorityMode: options?.serviceAuthorityMode,
      hasReporter: Boolean(options?.cuaOperationStateReporter),
    })
      ? options?.cuaOperationStateReporter
      : undefined,
    // 设置页的 HTTP 代理、No Proxy + 自定义 CA 按 spawn 时读取注入 agent 子进程 env，
    // 覆盖模型 API / MCP / Bash 出口流量并信任用户显式配置的证书；改动后下次启动 agent 生效。
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([settingService.get(), providerRuntime.start()]);
      // 内置 Subagent 的旧覆盖必须在 CLI 独立读取之前导入，不能等待设置页操作。
      await subagentsService.prepareRuntimeState();
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
      // 与 helper 创建同一个门控（isCuaEnabledForContext：dev/internal 特性 OR 官方插件 enablement），
      // 避免 dev mode 下 helper 建了但 resolveSpawnEnv 漏注入 broker env 的割裂。
      const cuaPluginEnabled = isCuaEnabledForContext(context);
      // 懒启动：darwin 上 spawn 绝不 acquire 拉起 Helper——已有 host（peek，比如刚走过
      // 授权流）则复用其 tuple；否则只注入稳定 socket，SDK 首次 CUA 调用自行拉起
      // （宿主启动/spawn 均不使 Helper 常驻）。win32 保留 acquire（token 模式）。
      const peekedHelper = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = !cuaPluginEnabled
        ? undefined
        : peekedHelper && isDefaultCuaProductHelperCurrent(peekedHelper)
          ? peekedHelper
          : process.platform === "darwin"
            ? undefined
            : await getOrCreateDefaultCuaProductHelper(context);
      // setting.get / 生命周期队列都可能跨过 host dispose。仅凭调用前的 enabled 会让延迟恢复的
      // resolveSpawnEnv 在 terminal fence 后重新启动 Helper；必须在真正构造 env 前校验代际。
      const cuaProductHelperHost =
        helper && isDefaultCuaProductHelperCurrent(helper) ? helper.host : undefined;
      // 等待 Helper 启动前登记。Registry 只记录尝试过 admission 的 workspace，
      // 供后续配置/生命周期 bookkeeping 使用；recovery 只清理 marker，不回收已有 Agent。
      cuaProductHelperWorkspaceRegistry.setEnabled(context, Boolean(cuaProductHelperHost));
      let cuaProductHelperEnv: Record<string, string> = {};
      if (!helper && cuaPluginEnabled && process.platform === "darwin") {
        // 懒启动：无托管 host 时注入稳定 socket；无 token（身份模式）、无 pluginAuthority
        // （其校验方就是 host，host 缺席时无意义）。SDK ensureBrokerAvailable 负责拉起。
        // pluginAuthority 是 agent 进程内的 config-provenance 随机数（bootstrap 捕获后写进
        // node_repl 配置 env，core 比对两者证明该配置出自本 bootstrap 而非用户配置文件）；
        // 它不需要 host——托管态由 host 铸造，懒启动态在此按 spawn 铸造，语义与校验完全一致。
        cuaProductHelperEnv = {
          [BROKER_SOCKET_ENV]: resolveBrokerSocketPath(),
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
        };
        cuaProductHelperWorkspaceRegistry.setEnabled(context, false);
      } else if (cuaProductHelperHost && helper) {
        const candidateEnv = await buildCuaProductHelperAgentEnv(
          cuaProductHelperHost,
          createServiceLogger("cua-product-helper"),
        );
        // host.start/checkHealth 也会 await；dispose 可能在这段等待中同步落 terminal fence。
        // 返回 spawn env 前二次核对代际，失效时显式标成 unavailable，绝不把已回收 tuple 交给晚到 Agent。
        if (isDefaultCuaProductHelperCurrent(helper)) {
          cuaProductHelperEnv = candidateEnv;
        } else {
          cuaProductHelperWorkspaceRegistry.setEnabled(context, false);
          cuaProductHelperEnv = {
            [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper lifecycle is disposed",
          };
        }
      } else if (cuaPluginEnabled && defaultCuaProductHelperLifecycle.disposed) {
        cuaProductHelperEnv = {
          [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper lifecycle is disposed",
        };
      }
      // Host 是旧配置迁移的唯一写入者。Agent spawn 前等待初始化完成，避免 Worker
      // 先拿到尚不存在的 provider_config.json 并发布短暂空 Registry。
      await providerConfigRuntime.start();
      return {
        ...buildAgentRuntimeEnv({
          httpProxy: agentNetwork.httpProxy,
          noProxy: agentNetwork.noProxy,
          caCertPath: settings.httpProxyCaCertPath,
        }),
        // 把 host 解析出的权威 origin（含 settings 覆盖）下发给 agent，否则 agent 侧只按
        // env 推导，test env + 自定义端点时两侧信任判定的输入分叉、官方 MCP 整体 fail closed。
        ...buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin()),
        // broker 凭据（socket/token）注入 agent spawn env，让内置 zcode-cua plugin 的
        // computer-use MCP server 经 __zcode-plugin-host 恢复 token 后连上 broker。
        // 上面 cuaProductHelperEnv 已完成代际校验与 unavailable 兜底，取代 staging 侧
        // 直接调用 buildCuaProductHelperAgentEnv 的旧路径。
        ...cuaProductHelperEnv,
        ...createNodeProviderRuntimePathEnv({
          // Host 与 Agent 共用同一随包配置路径，避免来源或内容 revision 不一致。
          zcodeBuiltinFilePath: await providerConfigRuntime.resolveZCodeBuiltinFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
          resolveSessionRuntimePreferences: async (scope) => {
            // 预算已统一，不能把可选远端配置作为本地/手机 shared-host 建会话的前置条件。
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // user-execution 只消费 Shell；共享默认策略是统一 result schema 的兼容占位，
              // 不会覆盖 runtime-materialization 阶段已经固定的 strategy。
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });
  providerConnectivityAgentService = zcodeAgentService;
  // Helper health probe 短暂超时不应在 Computer Use turn 中途回收 Agent。resolver 会把 restart
  // 推迟到下一个 request/turn 边界；若 broker 确实已失效，当前 turn 会自然失败并由下一次请求恢复。
  hasActiveTurnRef = () => zcodeAgentService.hasActiveCuaOperationTurn();
  // desktop-continuous UI 直接订阅 zcodeSessionService，绕开 ZCode task adapter 的
  // mapServiceEvent 路径，导致 task_complete 永远不会写回 sqlite，侧边栏 spinner 不停。
  // 在 services 层装配一个共享的 taskIndexRepo + syncer，session 任意入口都会唤醒
  // shadow 订阅，把 runtime 终态收敛进 sqlite。
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  // The plugin can be toggled at runtime. Do not let a previously created resolver continue
  // health-checking/restarting Helper after disable, and create it lazily after enable.
  // 动态 resolver：isPluginEnabled 与 helper 创建用同一个 isCuaEnabledForContext 门控（dev mode 一致），
  // 避免开发场景下 resolver pass-through 而 helper 已建的割裂。
  const defaultCuaProductMcpServerResolver = createDynamicCuaProductMcpServerResolver({
    isPluginEnabled: (context) => isCuaEnabledForContext(context),
    getResolver: async () => {
      // peek-only——resolver 属托管 host 体系，host 未建时返回 undefined（懒启动下
      // CUA 经 node_repl + 稳定 socket，不依赖此 resolver）；绝不在此 acquire。
      const helper = defaultCuaProductHelperLifecycle.peek()?.helper;
      return helper && isDefaultCuaProductHelperCurrent(helper) ? helper.resolver : undefined;
    },
    isResolverCurrent: (resolver) =>
      defaultCuaProductHelperLifecycle.peek()?.helper.resolver === resolver,
  });
  const cuaProductMcpServerResolver =
    options?.cuaProductMcpServerResolver ?? defaultCuaProductMcpServerResolver;
  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    cuaProductMcpServerResolver,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        // Git sidecar 属于目标 Environment；初始模型直接读取同一 Host View，
        // 不再通过临时 Agent workspace state 反推模型与 reasoning。
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // task wrapper 由 ZCode task service adapter 提供；核心 session 状态由 ZCode agent server 维护。
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    settingService,
    cuaProductMcpServerResolver,
  });
  const botRemoteWorkspaceService = createBotRemoteWorkspaceService({
    parentPort: options?.parentPort,
    settingService,
    credentialService,
  });
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        zcodeAgentService,
        zcodeSessionService,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  // AstrBot 桥接 provider：官方 BotsService 的一个传输 provider，host 负责 attach loopback WS。
  const astrBotProvider = createAstrBotBotProvider();
  const services = new ServiceCollection()
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(IZCodeTaskService, zcodeTaskService)
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(ICuaPermissionService, cuaPermissionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService,
        zcodeTaskService,
        broadcastService,
        settingService,
        modelSelectionService: providerRuntime.modelSelection,
        remoteWorkspaceService: botRemoteWorkspaceService,
        astrBotProvider,
        // 远端与本地 Bot 都读取所属 Environment 的 Model Selection View。
        // 远端启动期不再轮询旧 Preset，避免重新制造一套模型候选事实。
        runStartupBackgroundTasks: !isDesktopAttachedRemote,
      }),
    )
    .register(IFileWatcherService, createFileWatcherService())
    .register(IUsageStatsService, createUsageStatsService({ zcodeAgentService }))
    .register(ICodingPlanSubscriptionService, codingPlanSubscriptionService)
    .register(IClientConfigService, createClientConfigService())
    .register(IClientScenesService, createClientScenesService())
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    // 合并 MCP/Plugin Management 服务装配时误删了 plugin-sync 注册，
    // RemoteServiceAccess 仍会请求该频道，导致本地候选枚举超时、远端同步无法开始。
    .register(IPluginSyncService, pluginSyncService)
    .register(IPluginsService, createPluginsService({ isDesktopRuntime: true }))
    // 设置页插件管理薄服务——plugins/* 旧协议词的 host 侧唯一消费点。
    .register(IPluginManagementService, createPluginManagementService({ zcodeAgentService }))
    .register(ISubagentsService, subagentsService)
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
      }),
    )
    .register(IMemoryService, createMemoryService())
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  // 即使初始配置关闭也必须登记 lifecycle disposer：terminal fence 需要早于任意延迟 setting/acquire
  // 恢复，不能把"当前还没有 Helper"误当成"不需要生命周期所有者"。dispose 时串行 stop host。
  registerManagedCuaHelperHostForDispose(services, {
    stop: async () => {
      await defaultCuaProductHelperLifecycle.dispose();
    },
  });
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  // disposer 注册完成后才排预热。若 createLocalServices 中途抛错，不能留下一个无人持有、却会在当前
  // 调用栈结束后才创建的高权限 Helper；若返回后立即 dispose，terminal fence 会先于 acquire 生效。
  // Helper 懒启动：不预热——Helper 由 SDK 首次 CUA 调用拉起（spawn env 注入
  // 稳定 socket），或用户显式授权流（restartHelper）拉起。启动即零 Helper 常驻。

  providerRuntimes.set(services, providerRuntime);
  providerProvisioningSources.set(services, providerProvisioningSource);
  providerProvisioningTriggerDisposers.set(services, providerProvisioningDisposers);
  astrBotBridgeProviders.set(services, astrBotProvider);
  services
    .register(IProviderSettingsService, providerRuntime.providerSettings)
    .register(IModelSelectionService, providerRuntime.modelSelection);
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
  void providerRuntime.start().then(
    () => {
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      log.info("Provider Registry 已就绪", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error("Provider 配置事实初始化失败", error);
    },
  );

  // 见 sharedSqliteRepos 声明处注释：登记全部 tasks-index sqlite 句柄，dispose 链统一关闭
  sharedSqliteRepos.set(services, [taskIndexRepo]);
  return services;
}

export function disposeServiceResources(services: ServiceCollection): void {
  // host process 退出前以前没有统一遍历本地服务做资源回收，
  // terminal/task wrapper 这类会拉起子进程的服务只能等宿主进程自己结束，时序上可能留下短暂残留。
  // 这里集中调用各服务的本地 disposeAll 钩子，把“退出 app = 回收所有托管资源”落成机械动作。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 同步 best-effort：终止托管的 Computer Use Helper（不 await，避免阻断同步 dispose 路径）。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    void managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（Windows 上悬着句柄会让后续目录清理撞 EBUSY）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  // app 关闭时 host 需要等 agent 进程树完成 graceful + force 清理。
  // 旧的同步 dispose 会在 host 退出时丢掉强杀 timer，导致 zcode-cli/app-server 变成孤儿进程。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 等待托管的 Computer Use Helper 终止（best-effort）：Helper 是长生命周期高权限进程，服务释放语义必须显式
  // 收口它，不能只靠 launcher-pid watchdog / 进程退出兜底。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    await managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（同 disposeServiceResources，异步收口路径也要释放）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}

// AstrBot 桥接传输的 provider 与投递日志依赖 node:crypto，只能从 @zcode/services/node 引入。
// 官方 bots 服务（createBotsService）见上方；AstrBot 已作为其 astrbot provider 接入。
export type { BotsDeliveryReplay } from "./bots/botsDeliveryLog.js";
