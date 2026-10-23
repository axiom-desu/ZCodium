import type { AmendWorkflowRunSettingsInput } from "@zcode/core";
import type { ZCodeApp, ZCodeAppOptions } from "./types.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";

import type { AppDependencies } from "./create-app-dependencies.js";
import type { AppRuntimeBundle } from "./create-app-runtime.js";
import { createPromptAttachmentResolver } from "./create-app-prompt-attachments.js";
import { createAttachmentsSurface } from "./create-app-attachments-surface.js";
import { createWorkspaceHookSurface } from "./create-app-workspace-hook-surface.js";

export function createAppSurface(
  options: ZCodeAppOptions,
  deps: AppDependencies,
  bundle: AppRuntimeBundle,
): ZCodeApp {
  const {
    artifactStore,
    configResult,
    fileSystemPort,
    pluginReferenceCatalog,
    sessionId,
    sessionStore,
    traceContext,
    workingDirectory,
    workspaceHookRuntimeSecurity,
  } = deps;
  const {
    dynamicWorkflowRunPort,
    getRuntime,
    inputFacade,
    prepareUserExecutionBoundary,
    providerModelRuntime,
    resumeFromStore,
    runtime,
    scriptWorkflowFacade,
    sessionFacade,
    workflowFacade,
  } = bundle;
  const closeSession = sessionFacade.close;
  const resolvePromptAttachment = createPromptAttachmentResolver({
    sessionId,
    sessionStore,
  });
  return {
    sessionId,
    traceId: traceContext.traceId,
    runtime,
    ...createWorkspaceHookSurface(workspaceHookRuntimeSecurity),
    ...createAttachmentsSurface({
      artifactStore,
      fileSystemPort,
      resolvePromptAttachment,
      sessionId,
      traceContext,
    }),
    ...sessionFacade,
    close: async () => {
      try {
        await closeSession?.();
      } finally {
        providerModelRuntime?.dispose();
      }
    },
    ...workflowFacade,
    ...scriptWorkflowFacade,
    // dwf 事件日志的读面。**可选能力**：journal 不可用时 run service 整个不构造，
    // 这个方法随之缺席，v4 网关据此回结构化的能力不支持错误——「没有事件」与
    // 「这个会话没有这个能力」必须能被 renderer 区分。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : {
          listDynamicWorkflowRunEvents: async (input: {
            runId: string;
            afterSequence?: number;
            limit?: number;
          }) =>
            dynamicWorkflowRunPort.listEvents(input.runId, {
              ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }),
        }),
    // workflow run 的**用户面产物**读面。三条一起注册、
    // 一起缺席：它们是同一个 journal 读面的三个切片，部分在场只会让 UI 拿到一张有卡片
    // 却打不开的侧板。三个端口成员都是可选的（stub 端口不陪跑），所以逐个探测。
    // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是端口上的 `output`（顶层返回值）。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.listArtifacts !== "function" ||
    typeof dynamicWorkflowRunPort.listArtifactItems !== "function" ||
    typeof dynamicWorkflowRunPort.readArtifact !== "function"
      ? {}
      : {
          listDynamicWorkflowRunArtifacts: async (input: { runId: string }) =>
            dynamicWorkflowRunPort.listArtifacts!(input.runId),
          listDynamicWorkflowRunArtifactItems: async (input: {
            runId: string;
            artifactId: string;
            afterSequence?: number;
            limit: number;
          }) =>
            dynamicWorkflowRunPort.listArtifactItems!(input.runId, input.artifactId, {
              ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
              limit: input.limit,
            }),
          readDynamicWorkflowRunArtifact: async (input: {
            runId: string;
            artifactId: string;
            version: number;
          }) => dynamicWorkflowRunPort.readArtifact!(input.runId, input.artifactId, input.version),
        }),
    // workflow run 的工作区 transcript：两条一起
    // 注册、一起缺席，理由同产物的三条。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.listWorkspaceNodes !== "function" ||
    typeof dynamicWorkflowRunPort.readWorkspaceNodeResult !== "function"
      ? {}
      : {
          listDynamicWorkflowRunWorkspaceNodes: async (input: { runId: string }) =>
            dynamicWorkflowRunPort.listWorkspaceNodes!(input.runId),
          readDynamicWorkflowRunNodeResult: async (input: {
            runId: string;
            siteId: string;
            ordinal: number;
            maxBytes: number;
          }) =>
            dynamicWorkflowRunPort.readWorkspaceNodeResult!(
              input.runId,
              input.siteId,
              input.ordinal,
              { maxBytes: input.maxBytes },
            ),
        }),
    // workflow run 的会话级生命周期读面（在飞计数 + 结算订阅）。消费者是宿主的 provider registry
    // 安全边界：子代理共用本会话的 live adapter，在飞 run 期间不能 replace registry。缺席条件同上。
    ...(dynamicWorkflowRunPort === undefined ? {} : {}),
    // workflow run 的枚举面（重启后的发现查询）。能力缺席条件同上；端口的 listRunsForSession
    // 是可选成员，方法缺席时本能力同样不注册。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.listRunsForSession !== "function"
      ? {}
      : {
          listDynamicWorkflowRuns: async (input: { limit?: number }) =>
            dynamicWorkflowRunPort.listRunsForSession!(input.limit),
        }),
    // workflow run 的冷回放。能力缺席条件同上。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.replayProgressForSession !== "function"
      ? {}
      : {
          replayDynamicWorkflowRuns: async (input: { excludeRunIds: ReadonlySet<string> }) =>
            dynamicWorkflowRunPort.replayProgressForSession!(input),
        }),
    // dwf run 的恢复。能力缺席条件同上；此外
    // 端口的 resume 是可选成员（stub 端口不陪跑），方法缺席时本能力同样不注册——
    // 对 renderer「端口缺席」与「方法缺席」是同一个业务事实。
    ...(dynamicWorkflowRunPort === undefined || typeof dynamicWorkflowRunPort.resume !== "function"
      ? {}
      : {
          resumeWorkflowRun: async (input: { workId: string; name?: string }) => {
            const result = await dynamicWorkflowRunPort.resume!(input.workId);
            if (result.ok) {
              // 追踪重臂必须紧随成功的 resume：registry 登记（回收护栏）、backgroundWorks
              // 条目（cancellable）、终态通知。port.resume 已先替换注册表条目，
              // waiter 因此挂在新的结算 promise 上（run service 文件头不变式 5）。
              await getRuntime().trackResumedDynamicWorkflowRun({
                runId: result.runId,
                ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
                ...(input.name === undefined ? {} : { name: input.name }),
                traceContext,
              });
            }
            return result;
          },
        }),
    // 中枢直接启动一个已保存的工作流。能力缺席条件与
    // resumeWorkflowRun 家族一致：dwf 端口整体缺席（stub / 单测宿主）时不注册——GUI 据此拿到
    // 能力不支持错误并原样显示，而不是把「不支持直接启动」误当成一次失败的启动。
    // 与 /goal 控制轮同构：先走统一用户执行边界（否则首次持久化前 shell selection 为空，
    // 冷恢复退回 legacy fallback），再由 runtime 解析 + 校验 + 编译 + 落启动轮 + submit。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : {
          startSavedWorkflow: async (input: {
            name: string;
            scope?: "project" | "global";
            args?: Record<string, unknown>;
          }) => {
            await prepareUserExecutionBoundary({ traceContext });
            return await getRuntime().startSavedWorkflowRun({ ...input, traceContext });
          },
        }),
    // GUI「配置」。它
    // 沿用前驱的脚本，所以端口必须既能 amend 又能读回脚本；缺一就不注册，GUI 拿到能力不支持。
    // 与 startSavedWorkflow 同一条用户执行边界：冷恢复的会话先恢复 Session 边界再落设置轮。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.amend !== "function" ||
    typeof dynamicWorkflowRunPort.getScript !== "function"
      ? {}
      : {
          amendWorkflowRunSettings: async (
            input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
          ) => {
            await prepareUserExecutionBoundary({ traceContext });
            return await getRuntime().amendWorkflowRunSettings({ ...input, traceContext });
          },
        }),
    ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
    getPluginReferenceCatalog: () => pluginReferenceCatalog,
    getSkillCatalog: async () => {
      // Skill 目录属于 context 初始化结果。冷恢复必须先恢复 Session 边界，再读取
      // 新 runtime 的快照，不能绕开 resume 后用旧工作目录独立扫描。
      await prepareUserExecutionBoundary({ traceContext });
      return await getRuntime().getSkillCatalog(traceContext);
    },
    resume: resumeFromStore,
    ...inputFacade,
  };
}
