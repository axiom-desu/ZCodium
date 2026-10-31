import type { AppDependencies } from "./create-app-dependencies.js";
import type { RuntimeModelFactory } from "./provider-registry-model-runtime.js";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { AgentRuntime } from "@zcode/core";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

import type { ZCodeAppOptions } from "./types.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import { completeAppStartup, markRuntimeConstructed } from "./startup-marks.js";

interface AppAgentRuntimeInput {
  appVersion: AppDependencies["appVersion"];
  artifactStore: AppDependencies["artifactStore"];
  browserControlPort: AppDependencies["browserControlPort"];
  bundledSkillRoots: AppDependencies["bundledSkillRoots"];
  configResult: AppDependencies["configResult"];
  executionPort: AppDependencies["executionPort"];
  fileSystemPort: AppDependencies["fileSystemPort"];
  httpClientPort: AppDependencies["httpClientPort"];
  imageProcessorPort: AppDependencies["imageProcessorPort"];
  logger: AppDependencies["logger"];
  mcpPort: AppDependencies["mcpPort"];
  pdfDocumentPort: AppDependencies["pdfDocumentPort"];
  permissionService: AppDependencies["permissionService"];
  pluginOutcome: AppDependencies["pluginOutcome"];
  runtimeConfig: AppDependencies["runtimeConfig"];
  sessionId: AppDependencies["sessionId"];
  sessionMailboxPort: AppDependencies["sessionMailboxPort"];
  sessionStore: AppDependencies["sessionStore"];
  startupTimer: AppDependencies["startupTimer"];
  workingDirectory: AppDependencies["workingDirectory"];
  traceContext: AppDependencies["traceContext"];
  workspaceHookRuntimeSecurity: AppDependencies["workspaceHookRuntimeSecurity"];
  dynamicWorkflowRunPort: ReturnType<typeof createDynamicWorkflowRunService> | undefined;
  dynamicWorkflowSnippetPort: ReturnType<typeof createDynamicWorkflowSnippetService>;
  modelCatalogPort: ReturnType<typeof createModelCatalogPort>;
  modelFactory: RuntimeModelFactory;
  options: ZCodeAppOptions;
  scriptWorkflowFacade: ReturnType<typeof createScriptWorkflowBridge>;
  workflowConcurrencyGovernor: ReturnType<typeof getWorkflowConcurrencyGovernor>;
}

export function createAppAgentRuntime(input: AppAgentRuntimeInput): AgentRuntime {
  const appVersion = input.appVersion;
  const artifactStore = input.artifactStore;
  const browserControlPort = input.browserControlPort;
  const bundledSkillRoots = input.bundledSkillRoots;
  const configResult = input.configResult;
  const dynamicWorkflowRunPort = input.dynamicWorkflowRunPort;
  const dynamicWorkflowSnippetPort = input.dynamicWorkflowSnippetPort;
  const executionPort = input.executionPort;
  const fileSystemPort = input.fileSystemPort;
  const httpClientPort = input.httpClientPort;
  const imageProcessorPort = input.imageProcessorPort;
  const logger = input.logger;
  const mcpPort = input.mcpPort;
  const modelCatalogPort = input.modelCatalogPort;
  const modelFactory = input.modelFactory;
  const options = input.options;
  const pdfDocumentPort = input.pdfDocumentPort;
  const permissionService = input.permissionService;
  const pluginOutcome = input.pluginOutcome;
  const runtimeConfig = input.runtimeConfig;
  const scriptWorkflowFacade = input.scriptWorkflowFacade;
  const sessionId = input.sessionId;
  const sessionMailboxPort = input.sessionMailboxPort;
  const sessionStore = input.sessionStore;
  const startupTimer = input.startupTimer;
  const workingDirectory = input.workingDirectory;
  const traceContext = input.traceContext;
  const workflowConcurrencyGovernor = input.workflowConcurrencyGovernor;
  const workspaceHookRuntimeSecurity = input.workspaceHookRuntimeSecurity;
  const runtime = new AgentRuntime(sessionId, runtimeConfig, {
    // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
    modelRequestAdmission: workflowConcurrencyGovernor.observer(),
    eventStore: options.eventStore ?? createInMemorySessionEventStore(),
    sessionStore,
    sessionMailboxPort,
    logger,
    executionPort,
    workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
    workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
    browserControlPort,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    pdfDocumentPort,
    artifactStore,
    contextSourcePort:
      options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
    skillPort:
      configResult.config.features.skill && configResult.config.skills.enabled
        ? (options.skillPort ??
          createNodeSkillAdapter({
            additionalDirectories: options.additionalDirectories,
            extraRoots: configResult.config.skills.roots,
            extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
            disabledPaths: [
              ...collectDisabledPaths(configResult.config.skillOverrides),
              // 动态工作流关闭时不提供 dynamic-workflows 技能：
              // 十个工具都不在场，再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
              ...(runtimeConfig.dynamicWorkflowEnabled === false
                ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                : []),
            ],
          }))
        : undefined,
    mcpPort,
    eventSink: options.eventSink,
    modelFactory,
    resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
    isRemoteWorkspace: () =>
      isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
    permissionBroker: options.permissionBroker,
    permissionService,
    workflowPort: scriptWorkflowFacade.workflowPort,
    dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort,
    modelCatalogPort,
    automationPort: options.automationPort,
    appVersion,
    traceContext,
  });
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
  return runtime;
}
