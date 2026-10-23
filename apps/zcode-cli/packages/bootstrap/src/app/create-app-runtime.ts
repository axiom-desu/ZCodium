import { createAppResumePorts } from "./create-app-resume.js";
import { createAppDynamicWorkflowPorts } from "./create-app-dynamic-workflow.js";
import { createAppAgentRuntime } from "./create-app-agent-runtime.js";
import type { AppDependencies, RuntimeSlot } from "./create-app-dependencies.js";
import type { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
import type { PrepareUserExecutionBoundary } from "./types.js";
import { AgentRuntime } from "@zcode/core";

import { createModelAdapter } from "../model-factory.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type { ZCodeAppOptions } from "./types.js";
import { resolveEffectiveLocale } from "./app-config-options.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import { createInputFacade } from "./input-facade.js";
import { createSessionFacade } from "./session-facade.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { resolveZCodeCustomCommandPrompt } from "../custom-command-prompt.js";
import { resolveZCodeBuiltinPromptCommand } from "../builtin-prompt-command.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import { completeAppStartup, markRuntimeConstructed } from "./startup-marks.js";

export interface AppRuntimeBundle {
  dynamicWorkflowRunPort: ReturnType<typeof createDynamicWorkflowRunService> | undefined;
  getRuntime: () => AgentRuntime;
  inputFacade: ReturnType<typeof createInputFacade>;
  prepareResume: ReturnType<typeof createAppResumePorts>["prepareResume"];
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  providerModelRuntime: ApiProviderModelRuntime | undefined;
  resumeFromStore: ReturnType<typeof createAppResumePorts>["resumeFromStore"];
  runtime: AgentRuntime;
  scriptWorkflowFacade: ReturnType<typeof createScriptWorkflowBridge>;
  sessionFacade: ReturnType<typeof createSessionFacade>;
  workflowFacade: ReturnType<typeof createWorkflowFacade>;
}

export function createAppRuntime(
  options: ZCodeAppOptions,
  deps: AppDependencies,
): AppRuntimeBundle {
  const {
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
    ownsExecutionPort,
    ownsMcpPort,
    ownsSessionStore,
    pdfDocumentPort,
    permissionService,
    pluginOutcome,
    projectID,
    runtimeConfig,
    sessionId,
    sessionMailboxPort,
    sessionStore,
    startupTimer,
    ownedNodeReplBrowserBroker,
    storageRoot,
    traceContext,
    untrustedProjectMcpServers,
    workingDirectory,
    workspaceHookRuntimeSecurity,
  } = deps;

  let runtime: AgentRuntime | undefined;
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  const runtimeSlot: RuntimeSlot = deps.runtimeSlot;
  const getRuntime = (): AgentRuntime => {
    if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
    return runtime;
  };
  const resumePorts = createAppResumePorts({
    getRuntime,
    logger,
    options,
    sessionId,
    sessionStore,
    traceContext,
  });
  const { prepareResume, prepareUserExecutionBoundary, resumeFromStore } = resumePorts;

  const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
    network: configResult.config.network,
  });
  const modelAdapter =
    options.modelAdapter ??
    createModelAdapter({
      env: options.env,
      logger: modelLogger,
      executionConfig: modelExecutionConfig,
      streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
    });
  // 进程级并发治理器：run service 拿它的窄端口给
  // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
  // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
  // 同一事件只能沿 ticket 投递给治理器一次。
  const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
  providerModelRuntime = new ApiProviderModelRuntime({
    registry: options.providerRegistry,
    modelAdapter,
  });
  providerModelRuntime.start();
  // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
  // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
  // 新建的 Model 才看得到，child 不各自冻结一份。
  const modelFactory = providerModelRuntime.modelFactory;
  const scriptWorkflowFacade = createScriptWorkflowBridge({
    appOptions: options,
    appVersion,
    artifactStore,
    configResult,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    pdfDocumentPort,
    logger,
    mcpPort,
    modelFactory,
    permissionService,
    prepareUserExecutionBoundary,
    getRuntime,
    runtimeConfig,
    sessionId,
    sessionStore,
    workingDirectory,
    storageRoot,
    traceContext,
  });

  const { dynamicWorkflowRunPort, dynamicWorkflowSnippetPort, modelCatalogPort } =
    createAppDynamicWorkflowPorts({
      appVersion,
      artifactStore,
      configResult,
      executionPort,
      fileSystemPort,
      browserControlPort,
      getRuntime,
      httpClientPort,
      imageProcessorPort,
      logger,
      mcpPort,
      modelFactory,
      options,
      permissionService,
      runtimeConfig,
      sessionId,
      sessionStore,
      workingDirectory,
      storageRoot,
      traceContext,
      workflowConcurrencyGovernor,
    });
  runtime = createAppAgentRuntime({
    appVersion,
    artifactStore,
    browserControlPort,
    bundledSkillRoots,
    configResult,
    dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort,
    executionPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    logger,
    mcpPort,
    modelCatalogPort,
    modelFactory,
    options,
    pdfDocumentPort,
    permissionService,
    pluginOutcome,
    runtimeConfig,
    scriptWorkflowFacade,
    sessionId,
    sessionMailboxPort,
    sessionStore,
    startupTimer,
    traceContext,
    workingDirectory,
    workflowConcurrencyGovernor,
    workspaceHookRuntimeSecurity,
  });
  runtimeSlot.current = runtime;
  markRuntimeConstructed({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    sessionId,
    startupTimer,
  });
  completeAppStartup({
    sessionId,
    startupTimer,
    workingDirectory,
  });
  scheduleStartupLogRetentionCleanup(loggerFactory, logger);
  const inputFacade = createInputFacade({
    artifactStore,
    customCommandPromptResolver: async (text, resolverOptions) => {
      const builtinPrompt = resolveZCodeBuiltinPromptCommand(text, {
        // 动态工作流关闭时内置 `/workflow` 不得展开。目录侧已经把它从 `/` 面板
        // 剔除，但用户仍可手打命令名，两条路径必须给出同一个结论。TUI 缺席时不设门禁；
        // headless 按 --enable-workflow 显式取值，见 runtimeConfig 字段注释。
        dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
        workingDirectory,
      });
      if (builtinPrompt !== undefined) {
        return builtinPrompt;
      }
      return await resolveZCodeCustomCommandPrompt(text, {
        env: options.env,
        executionPort,
        logger,
        projectConfigPath: options.projectConfigPath,
        sessionId,
        signal: resolverOptions?.abortSignal,
        skipUserConfig: options.skipUserConfig,
        traceContext: resolverOptions?.traceContext ?? traceContext,
        userConfigPath: options.userConfigPath,
        workingDirectory,
      });
    },
    inputHistoryStore,
    logger,
    prepareUserExecutionBoundary,
    runtime,
    sessionId,
    traceContext,
  });
  const workflowFacade = createWorkflowFacade({
    appOptions: options,
    appVersion,
    artifactStore,
    cliStorageRoot,
    configResult,
    eventSink: options.eventSink,
    imageProcessorPort,
    pdfDocumentPort,
    logger,
    mcpPort,
    modelFactory,
    permissionService,
    prepareUserExecutionBoundary,
    runtime,
    runtimeConfig,
    sessionId,
    sessionStore,
    workingDirectory,
    storageRoot,
    traceContext,
  });
  const sessionFacade = createSessionFacade({
    // App 关闭时停下本会话拥有的 dwf run：
    // 引擎活在本 App 的闭包里，关掉 App 而不停它，journal 行会停在 running 等下一次孤儿收敛。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
    configResult,
    configuredMcpServers,
    ...(options.configuredDefaultModelSelection
      ? {
          configuredDefaultModelSelection: options.configuredDefaultModelSelection,
        }
      : {}),
    executionPort,
    localSettingStore,
    logger,
    loggerFactory,
    mcpPort,
    ownsExecutionPort,
    ownsMcpPort,
    closeNodeReplBrowserBroker: async () => {
      await ownedNodeReplBrowserBroker?.close();
    },
    ownsSessionStore,
    prepareUserExecutionBoundary,
    prepareResume,
    projectID,
    providerRegistry: options.providerRegistry,
    resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
    runtime,
    sessionId,
    sessionStore,
    traceContext,
    untrustedProjectMcpServers,
    workingDirectory,
  });

  return {
    dynamicWorkflowRunPort,
    getRuntime,
    inputFacade,
    prepareResume,
    prepareUserExecutionBoundary,
    providerModelRuntime,
    resumeFromStore,
    runtime,
    scriptWorkflowFacade,
    sessionFacade,
    workflowFacade,
  };
}
