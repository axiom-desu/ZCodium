import type { ConfigResult } from "@zcode/adapters/config";
import type { Logger, LoggerFactory } from "@zcode/contracts";
import type { NodeReplBrowserBroker } from "./node-repl-browser-broker.js";
import { createAppAdapterPorts } from "./create-app-adapters.js";
import {
  resolveAppStartupIdentity,
  type AppStartupIdentity,
} from "./create-app-startup-identity.js";
import { join } from "node:path";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { AgentRuntime, PermissionService, buildPluginReferenceCatalog } from "@zcode/core";
import { traceContextToLogContext, createSessionEvent } from "@zcode/contracts";

import { StartupTimer } from "../startup-logging.js";
import type { ZCodeAppOptions } from "./types.js";
import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";
import { getCliStorageRoot, projectIdFromDirectory } from "./paths.js";
import {
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
} from "./session-store.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { resolveAppRuntimeConfig, runtimeConfigLogContext } from "./runtime-config.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { loadPluginAgentProfiles, loadZCodeAgentProfiles } from "../subagents.js";
import {
  debugRuntimeConfigResolved,
  markConfigurationLoaded,
  markMcpAdapterInitialized,
  markStorageAdaptersInitialized,
  resolveStartupPlugins,
  startAppStartup,
} from "./startup-marks.js";

export interface AppDependencies {
  appVersion: string;
  artifactStore: import("@zcode/contracts").ToolArtifactStorePort;
  browserControlPort: import("@zcode/contracts").BrowserControlPort | undefined;
  bundledSkillRoots: Awaited<ReturnType<typeof resolveBundledSkillRoots>>;
  cliStorageRoot: string;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, import("@zcode/contracts").McpServerConfig>;
  executionPort: import("@zcode/contracts").ExecutionPort;
  fileSystemPort: import("@zcode/contracts").FileSystemPort;
  httpClientPort: import("@zcode/contracts").HttpClientPort;
  imageProcessorPort: import("@zcode/contracts").ImageProcessorPort;
  inputHistoryStore: import("@zcode/contracts").InputHistoryStorePort | undefined;
  localSettingStore: ReturnType<typeof asLocalSettingStore>;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort: import("@zcode/contracts").McpPort | undefined;
  modelLogger: Logger;
  nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  pdfDocumentPort: import("@zcode/contracts").PdfDocumentPort;
  permissionService: PermissionService;
  pluginOutcome: ReturnType<typeof resolveStartupPlugins>;
  pluginReferenceCatalog: import("@zcode/contracts").PluginReferenceCatalog;
  pluginRuntimeFeatures: ReturnType<typeof resolvePluginRuntimeFeatures>;
  projectID: import("@zcode/contracts").ProjectId;
  runtimeConfig: import("@zcode/core").AgentRuntimeConfig;
  runtimeSlot: RuntimeSlot;
  sessionId: import("@zcode/contracts").SessionId;
  sessionMailboxPort: import("@zcode/contracts").SessionMailboxPort | undefined;
  sessionStore: import("@zcode/contracts").SessionStorePort;
  startupStartedAt: number;
  startupTimer: StartupTimer;
  storageRoot: string;
  traceContext: import("@zcode/contracts").TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
  workspaceHookRuntimeSecurity: ReturnType<typeof createWorkspaceHookRuntimeSecurity> | undefined;
}

export interface RuntimeSlot {
  current?: AgentRuntime;
}

export async function resolveAppDependencies(
  options: ZCodeAppOptions,
  identity: AppStartupIdentity = resolveAppStartupIdentity(options),
): Promise<AppDependencies> {
  const { appVersion, sessionId, startupStartedAt, traceContext, workingDirectory } = identity;
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "zcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const cliStorageRoot = getCliStorageRoot(storageRoot);
  const zcodeSubagentProfileOutcome = await loadZCodeAgentProfiles({
    logger,
    storageRoot,
    workingDirectory,
  });
  const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: options.env,
    logger,
    options,
    startupTimer,
    workingDirectory,
  });
  // 随 CLI 内置的技能包（dynamic-workflows 等）：不属于任何插件，用户无法停用或卸载。
  const bundledSkillRoots = await resolveBundledSkillRoots({ cliStorageRoot, logger });
  const pluginSubagentProfiles = loadPluginAgentProfiles({
    logger,
    plugins: pluginOutcome.plugins,
    reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
    modelSelectionOverrides: zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
  }).profiles;
  const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
  const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome,
    workingDirectory,
  });
  // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
  const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];
  const ownsSessionStore = options.sessionStore === undefined;
  const sessionStore =
    options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
  const localSettingStore = asLocalSettingStore(sessionStore);
  const projectID = projectIdFromDirectory(workingDirectory);
  const persistedMode = options.runtimeConfig?.mode
    ? undefined
    : readProjectPermissionMode(localSettingStore, projectID);
  let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } = resolveAppRuntimeConfig(
    {
      cliStorageRoot,
      configResult,
      options,
      persistedMode,
      pluginHooks: pluginOutcome.hooks,
      pluginMcpServers: pluginOutcome.mcpServers,
      builtInMcpServers,
      pluginRuntimeFeatures,
      builtInSubagentModelSelectionOverrides:
        zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
      subagentOutputRootDir: join(cliStorageRoot, "agents"),
      subagentProfiles,
      storageRoot,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
    },
  );
  const browserControlPort = options.browserControlPort;
  if (
    browserControlPort &&
    pluginRuntimeFeatures.browserUse === true &&
    runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
  ) {
    nodeReplBrowserBroker =
      options.nodeReplBrowserBroker ??
      (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort,
        logger,
        platform: options.platform,
      }));
    configuredMcpServers = injectNodeReplBrowserBroker(configuredMcpServers, nodeReplBrowserBroker);
    runtimeConfig.mcp = {
      ...runtimeConfig.mcp,
      servers: injectNodeReplBrowserBroker(runtimeConfig.mcp.servers ?? {}, nodeReplBrowserBroker),
    };
  }
  startupTimer.mark("ZCode runtime configuration resolved", {
    context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
    event: "bootstrap.app.startup.runtime_config.completed",
    stage: "resolve_runtime_config",
  });
  // Plugin 对话引用：身份 catalog 在 App（Session runtime）
  // 创建时冻结一次。冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新 Plugin。
  const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
  runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
  const runtimeSlot: RuntimeSlot = {};
  const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
    appVersion,
    logger,
    projectConfigPath: options.projectConfigPath,
    policy: options.workspaceHookPolicy,
    policyProvider: options.workspaceHookPolicyProvider,
    reviewHost: options.workspaceHookReviewHost,
    workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
    runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
      // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
      // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
      // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
      // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
      // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
      enabled: runtimeConfig.hooks?.enabled === true,
      timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
      maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
    },
    sessionId,
    snapshot: configResult.sources.project.workspaceHookSnapshot,
    userConfigPath: configResult.sources.user.path,
    workingDirectory,
    ...(options.workspaceHookReviewHost
      ? {
          emitReviewEvent: async (event) => {
            if (!runtimeSlot.current) throw new Error("ZCode runtime is not initialized yet.");
            await runtimeSlot.current.appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
          emitAdmissionEvent: async (event) => {
            if (!runtimeSlot.current) throw new Error("ZCode runtime is not initialized yet.");
            await runtimeSlot.current.appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
        }
      : {}),
  });
  const permissionService = new PermissionService({
    allowedTools: new Set(configResult.config.permission.allowedTools),
    autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
    disallowedTools: new Set(configResult.config.permission.disallowedTools),
    allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
  });
  const {
    artifactStore,
    executionPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    inputHistoryStore,
    mcpPort,
    ownsExecutionPort,
    ownsMcpPort,
    pdfDocumentPort,
    sessionMailboxPort,
  } = createAppAdapterPorts(
    {
      appVersion,
      configResult,
      logger,
      options,
      runtimeConfig,
      sessionStore,
      storageRoot,
      workingDirectory,
    },
    () =>
      markStorageAdaptersInitialized({
        cliStorageRoot,
        hasInjectedArtifactStore: options.artifactStore !== undefined,
        hasInjectedSessionStore: options.sessionStore !== undefined,
        startupTimer,
        storageRoot,
      }),
  );
  markMcpAdapterInitialized({
    configuredMcpServers,
    hasInjectedMcpPort: options.mcpPort !== undefined,
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    startupTimer,
    trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
  });
  debugRuntimeConfigResolved({
    configResult,
    logger,
    runtimeConfig,
  });

  return {
    appVersion,
    artifactStore,
    browserControlPort,
    bundledSkillRoots,
    cliStorageRoot,
    configResult,
    configuredMcpServers,
    executionPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    inputHistoryStore,
    localSettingStore,
    logger,
    loggerFactory,
    mcpPort,
    modelLogger,
    nodeReplBrowserBroker,
    ownedNodeReplBrowserBroker,
    ownsExecutionPort,
    ownsMcpPort,
    ownsSessionStore,
    pdfDocumentPort,
    permissionService,
    pluginOutcome,
    pluginReferenceCatalog,
    pluginRuntimeFeatures,
    projectID,
    runtimeConfig,
    runtimeSlot,
    sessionId,
    sessionMailboxPort,
    sessionStore,
    startupStartedAt,
    startupTimer,
    storageRoot,
    traceContext,
    untrustedProjectMcpServers,
    workingDirectory,
    workspaceHookRuntimeSecurity,
  };
}
