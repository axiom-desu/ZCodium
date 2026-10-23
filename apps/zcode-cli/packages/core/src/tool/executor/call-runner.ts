import {
  CoreErrorType,
  createChildTraceContext,
  createCoreError,
  createRootTraceContext,
  getCurrentTraceContext,
  traceContextToLogContext,
} from "@zcode/contracts";
import {
  normalizeToolExecutionInput,
  prepareInitialToolExecutionInput,
} from "../input-normalization.js";
import { resolveToolEntryModelContract } from "../model-contract.js";
import { resolveDeferredToolCall } from "../deferred-call.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import { finishToolCallSuccess } from "./tool-call-success.js";
import {
  appendPreToolAdditionalContextsToErrorResult,
  isEmptyToolName,
  resolveModelOutputEntry,
} from "./call-runner-helpers.js";
import { createToolExecutionContext } from "./execution-context.js";
import { handleToolCallFailure } from "./tool-call-failure.js";
import {
  createErrorResult,
  createPermissionErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
} from "./errors.js";
import { emitToolCallError, emitToolCallStarted } from "./events.js";
import { runPreToolUseHooks } from "./hook-flow.js";
import { resolveToolCallCapabilityFlags } from "./permission-capability.js";
import { resolveToolPermission } from "./permission-flow.js";
import { createMcpToolDisplay } from "./result-display.js";
import { ToolDeadline, executeWithTimeout, linkAbortSignal, resolveTimeoutMs } from "./timeout.js";
import { withPlanExitDeniedTurnStop, withWorkflowRefineDeniedFollowUp } from "./turn-control.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateInitialModelToolInput, validateInput, validateOutput } from "./validation.js";

const UNDISCOVERED_TOOL_SCHEMA_EXPLANATION =
  "\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. " +
  "Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ";

export async function executeToolCall(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  options?: ToolExecuteOptions,
): Promise<ToolExecutionResult> {
  const totalStartedAt = Date.now();
  return executeToolCallImpl(deps, backgroundTasks, toolCall, totalStartedAt, options);
}

async function executeToolCallImpl(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  totalStartedAt: number,
  options?: ToolExecuteOptions,
): Promise<ToolExecutionResult> {
  // 包装调用在任何目标事件/权限/Hook 之前解包；失败保持包装身份，不触发目标生命周期。
  const admission = resolveDeferredToolCall(toolCall, options?.toolSearch, deps.registry);
  if (admission.error) {
    const result = createErrorResult(admission.call, admission.error);
    await emitToolCallError(
      deps,
      toolCall.id,
      options?.traceContext ??
        deps.traceContext ??
        createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId }),
      deps.turnId,
      result.error,
    );
    return result;
  }
  // 历史只保存一份原始目标参数；执行/Hook 可修改的对象在执行入口独立复制。
  toolCall = admission.call.modelCallWrapper
    ? { ...admission.call, input: structuredClone(admission.call.input) }
    : admission.call;
  const parentTraceContext =
    options?.traceContext ??
    getCurrentTraceContext() ??
    deps.traceContext ??
    createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
  const emptyToolName = isEmptyToolName(toolCall.name);
  const registeredEntry = emptyToolName ? undefined : deps.registry.get(toolCall.name);
  const model = options?.model ?? deps.model;
  const entry = registeredEntry
    ? resolveToolEntryModelContract(registeredEntry, {
        model,
      })
    : undefined;
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  const traceContext = createChildTraceContext(parentTraceContext, {
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    attributes: {
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    },
  });
  const traceId = traceContext.traceId;
  const turnId = traceContext.turnId ?? deps.turnId;

  if (!entry) {
    const result = createErrorResult(
      toolCall,
      createCoreError(
        CoreErrorType.ToolNotFound,
        emptyToolName
          ? "Model returned an invalid tool call: tool name is empty."
          : `Tool not found: ${toolCall.name}`,
        {
          context: { toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: false,
        },
      ),
    );
    if (emptyToolName) {
      // 空名在 admission 阶段停止会让模型永远收不到配对结果。复用
      // registry-miss 生命周期，但 provider 内容严格保留模型返回的原始空白名称。
      result.modelContent = `<tool_use_error>Error: No such tool available: ${toolCall.name}</tool_use_error>`;
    }
    // registry miss 发生在 handler/ToolCallStarted 之前；旧代码只把失败
    // 返回给 provider，没有发布 ToolCallError，V4 tool row 因而永久停在 inputStreaming。
    await emitToolCallError(deps, toolCall.id, traceContext, turnId, result.error);
    deps.logger?.warn("Tool call rejected because the tool is not registered", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.not_found",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return result;
  }

  let lifetime: ReturnType<NonNullable<ToolEntry["retainExecution"]>> | undefined;
  try {
    lifetime = entry.retainExecution?.(canonicalToolCall.id);
  } catch (error) {
    const result = createErrorResult(
      canonicalToolCall,
      createCoreError(
        CoreErrorType.ToolCancelled,
        error instanceof Error ? error.message : "Tool instance is unavailable",
      ),
    );
    await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
    return result;
  }
  if (lifetime)
    options = {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, lifetime.signal])
        : lifetime.signal,
    };
  try {
    const mode = deps.getMode();

    if (options?.signal?.aborted) {
      const result = createErrorResult(
        canonicalToolCall,
        createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled"),
      );
      return result;
    }

    const preparedInitialInput = prepareInitialToolExecutionInput({
      entry,
      input: canonicalToolCall.input,
      logger: deps.logger,
    });
    let executionInput = preparedInitialInput.input;
    const initialInputValidation = validateInitialModelToolInput(
      executionInput,
      entry,
      preparedInitialInput.runtimeValidationIssues,
    );
    if (initialInputValidation) {
      const result = createErrorResult(canonicalToolCall, initialInputValidation);
      const search = options?.toolSearch;
      // 延迟 schema 未加载只提供纠错提示，不增加工具执行拒绝条件。
      if (
        search?.enabled &&
        !search.discovered.has(canonicalToolCall.name) &&
        search.catalog.some((tool) => tool.name === canonicalToolCall.name && tool.deferred)
      ) {
        // 原提示省略了类型退化原因；完整解释与 schema 一并提供，避免只引导盲目重试。
        result.modelContent =
          (result.modelContent ?? initialInputValidation.message) +
          UNDISCOVERED_TOOL_SCHEMA_EXPLANATION +
          `Load the tool first: call ToolSearch with query "select:${canonicalToolCall.name}", then retry this call. ` +
          `For reference, this tool's input schema is: ${JSON.stringify(entry.inputSchema)}` +
          (search.mode === "local"
            ? `\nCall DeferredToolCall with {name: "${canonicalToolCall.name}", input: {...}}.`
            : "");
      }
      // schema 失败与 registry miss 同属 handler/ToolCallStarted 之前的早退；旧代码
      // 只把失败回灌模型，没有发布 ToolCallError，V4 tool row 因而在整个 turn 里停在
      // inputStreaming（CreateWorkflow 卡持续显示「正在编写工作流」），模型重试后又叠一张。
      await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
      return result;
    }

    const toolInputValidation = entry.validateInput?.(executionInput, {
      runtimeTaskRegistry: deps.runtimeTaskRegistry,
    });
    if (toolInputValidation && isToolHandlerFailure(toolInputValidation)) {
      // tool-specific 语义校验原先只能放在 handler，导致无效调用仍先执行
      // PreToolUse、权限和 failure hook；语义校验必须在 hook 前结束。
      const result = createErrorResult(
        canonicalToolCall,
        createToolHandlerFailureError(canonicalToolCall, toolInputValidation),
      );
      await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
      // 工具专属校验以普通失败结果返回，不走 handler 执行的 try/catch 失败收口。
      // 先发出 ToolCallError 更新工具行，再显式标记遥测失败，避免被记录为 abandoned。
      return result;
    }

    // 归一化：把模型发出的入参换成「将要发生的执行事实」。位置刻意在 hook **之前**——此后
    // hook、权限规则、确认窗载荷、prepareApproval 与 handler 读的都是同一份输入，于是
    // 「策略看得到真正的脚本」「跨版本可见」「确认与执行同字节」三件事一次到位。
    if (entry.resolveInput) {
      const workingDirectory = deps.getWorkingDirectory?.();
      const resolution = await entry.resolveInput(executionInput, {
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        runtimeTaskRegistry: deps.runtimeTaskRegistry,
        ...(deps.dynamicWorkflowRunPort === undefined
          ? {}
          : { dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort }),
        ...(deps.modelCatalogPort === undefined ? {} : { modelCatalogPort: deps.modelCatalogPort }),
        sessionId: deps.sessionId,
        ...(deps.hasLoadedSkill === undefined ? {} : { hasLoadedSkill: deps.hasLoadedSkill }),
      });
      if (isToolHandlerFailure(resolution)) {
        // 与 validateInput 同一条生命周期出口：解析不出来是模型该立刻拿回去修的东西，
        // 不该先弹一次注定失败的确认窗。
        const result = createErrorResult(
          canonicalToolCall,
          createToolHandlerFailureError(canonicalToolCall, resolution),
        );
        await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
        return result;
      }
      executionInput = resolution.input;
    }

    const preToolHookResult = await runPreToolUseHooks(
      deps,
      canonicalToolCall,
      executionInput,
      entry,
      mode,
      traceContext,
      options?.signal,
    );
    if (preToolHookResult.permissionBehavior === "deny" || preToolHookResult.preventContinuation) {
      const result = appendPreToolAdditionalContextsToErrorResult(
        withPlanExitDeniedTurnStop(
          createPermissionErrorResult(
            canonicalToolCall,
            preToolHookResult.hookPermissionDecisionReason ??
              preToolHookResult.stopReason ??
              "Blocked by PreToolUse hook",
            {
              decision: "deny",
              mode,
              reason:
                preToolHookResult.hookPermissionDecisionReason ?? preToolHookResult.stopReason,
              source: "hook.PreToolUse",
            },
          ),
          {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          },
        ),
        preToolHookResult.additionalContexts,
      );
      return result;
    }
    if (preToolHookResult.updatedInput !== undefined) {
      executionInput = normalizeToolExecutionInput({
        entry,
        input: preToolHookResult.updatedInput,
        logger: deps.logger,
        source: "hook",
      });
      const hookInputValidation = validateInput(executionInput, entry);
      if (hookInputValidation) {
        // Hook 修改后的输入校验失败会在 handler 前直接返回，旧分支没有走
        // PreToolUse context 的统一追加逻辑，导致模型只看到 schema error，看不到 Hook
        // 已产生的诊断上下文；与 deny、permission-deny 的提前失败契约不一致。
        const result = appendPreToolAdditionalContextsToErrorResult(
          createErrorResult(canonicalToolCall, hookInputValidation),
          preToolHookResult.additionalContexts,
        );
        return result;
      }
    }

    const permissionResult = await resolveToolPermission(
      deps,
      canonicalToolCall,
      entry,
      executionInput,
      preToolHookResult,
      mode,
      traceContext,
      options?.signal,
    );
    if (!permissionResult.allowed) {
      const result = appendPreToolAdditionalContextsToErrorResult(
        withWorkflowRefineDeniedFollowUp(
          withPlanExitDeniedTurnStop(permissionResult.result, {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          }),
          { toolName: canonicalToolCall.name },
        ),
        preToolHookResult.additionalContexts,
      );
      return result;
    }
    executionInput = permissionResult.executionInput;
    const permissionWaitMs = permissionResult.permissionWaitMs;

    const startTime = Date.now();
    // 按**执行入参**解析一次副作用旗标（Bash 的只读命令判定就在这里落定），随 ToolCallStarted 发出：
    // 事件先于 handler，所以订阅者（dynamic-workflow driver 的导入缓存关门）在第一个字节落盘前就知道。
    await emitToolCallStarted(
      deps,
      canonicalToolCall,
      traceContext,
      turnId,
      startTime,
      createMcpToolDisplay(entry.metadata.mcpPresentation),
      resolveToolCallCapabilityFlags(deps, entry, executionInput),
    );

    deps.logger?.info("Tool call started", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.started",
      module: "core.tool.executor",
      status: "started",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    });

    const timeoutMs = resolveTimeoutMs(entry, executionInput, deps.defaultTimeoutMs, {
      model,
    });
    const executionAbortController = new AbortController();
    const unlinkParentAbort = linkAbortSignal(options?.signal, executionAbortController);
    // 可暂停的 deadline：本次调用内部的模型请求在准入闸门前排队时暂停计时。排队的两端
    // 以本 toolCallId 的 ModelNetworkStatus 会话事件到达，所以在事件出口拦一层即可，handler 无感。
    const deadline = new ToolDeadline(timeoutMs);
    let readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];

    try {
      const context = createToolExecutionContext({
        abortSignal: executionAbortController.signal,
        canonicalToolCall,
        deadline,
        deps,
        executionInput,
        onReadFileStateMetadata: (metadata) => {
          readFileStateMetadata = metadata;
        },
        options,
        traceContext,
        traceId,
        turnId,
      });

      const output = await executeWithTimeout(
        entry.handler,
        executionInput,
        context,
        deadline,
        executionAbortController,
        entry,
      );
      const durationMs = Date.now() - startTime;
      if (isToolHandlerFailure(output)) {
        // handler 用返回值表达可预期业务失败；这里只转换到既有异常控制流，
        // 继续复用原来的 failure hook、事件和日志，不引入第二套执行生命周期。
        throw createToolHandlerFailureError(canonicalToolCall, output);
      }
      validateOutput(output, entry);
      // node_repl 同时承载 Browser Use 与 CUA，不能在注册时把整个 server 标成 official。
      // CUA SDK 结果带 producer integrity metadata 时，才为本次序列化临时打开原子帧保护；
      // 否则通用 resultBudget 会截断/重排 image_ref，或非 authority 路径会把引用剥掉。
      const modelOutputEntry = resolveModelOutputEntry(entry, output);
      return await finishToolCallSuccess({
        backgroundTasks,
        canonicalToolCall,
        deps,
        entry,
        executionAbortController,
        durationMs,
        modelOutputEntry,
        executionInput,
        output,
        permissionWaitMs,
        preToolHookResult,
        readFileStateMetadata,
        startTime,
        totalStartedAt,
        traceContext,
        turnId,
        signal: options?.signal,
      });
    } catch (error) {
      return await handleToolCallFailure({
        deps,
        canonicalToolCall,
        executionInput,
        error,
        options,
        preToolHookResult,
        startTime,
        traceContext,
        turnId,
      });
    } finally {
      unlinkParentAbort();
    }
  } finally {
    lifetime?.release();
  }
}
