import {
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRuntimeModel } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

/**
 * 已接纳的选型序号（每 runtime 一份）与已发布选型（仅用于 ModelSelected 的前后展示边界）。
 *
 * 两者刻意分开：写入会话的是「已接纳」的意图，展示的是「已发布」的那一次切换；
 * 展示边界不得反推持久选择，否则一条迟到的旧命令会让界面倒退回它自己的快照。
 */
const selectionAdmissions = new WeakMap<
  AgentRuntimeInternal,
  { sequence: number; commandId: string; persisted: Promise<void> }
>();
const publishedSelections = new WeakMap<AgentRuntimeInternal, ModelSelection | undefined>();

/** 记下本次已发布的会话选型（`emitModelSelected` 成功后调用）。 */
export function recordPublishedModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): void {
  publishedSelections.set(runtime, cloneModelSelection(selection));
}

/**
 * 在**接纳**时刻固定本次输入声明的会话选型，而不是等 drain 时读会话当前值。
 *
 * 为什么必须提前：队列里可能同时排着旧输入（声明 A）与更新的切换（B）。若由 drain 写会话，
 * 先跑的旧输入会把用户后来的选择覆盖回 A；先接纳则「后写覆盖先写」只允许沿 `admissionSeq`
 * 前进，旧命令最多只影响它自己那一轮。
 *
 * 三条边界：
 *   - `selectionScope === "execution"` 的执行级选型不改会话默认（既有不变式），本轮模型仍取声明值；
 *   - 幂等比的是「同一 `sourceCommandId`」与「`admissionSeq` 不前进」，命中就复用上次的持久化 promise；
 *   - 持久化按接纳顺序串行（链在上一次的 promise 后），旧异步写不会落库在新选择之后；
 *     会话行尚未创建时跳过（`ensureSessionPersisted` 会把当前选型写成初始 entry）。
 */
export function acceptSubmissionModelSelection(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  _traceContext: TraceContext,
  modelExecution?: Pick<import("../types.js").ModelExecutionContext, "selectionScope">,
): Promise<void> {
  if (modelExecution?.selectionScope === "execution") return Promise.resolve();
  const selection = intent?.modelSelection;
  if (!selection || !intent) return Promise.resolve();
  const previous = selectionAdmissions.get(runtime);
  if (
    previous &&
    (previous.commandId === intent.sourceCommandId ||
      (Number.isFinite(intent.admissionSeq) && intent.admissionSeq <= previous.sequence))
  ) {
    return previous.persisted;
  }
  // 首次接纳时把「接纳前的会话选择」种进展示边界：resume 的会话第一条命令也要给出正确的
  // ModelSelected.previous，而不是伪造一个 ∅→X 的模型边界。
  if (!publishedSelections.has(runtime)) {
    publishedSelections.set(runtime, runtime.getSessionModelSelection());
  }
  const appliedSelection = cloneModelSelection(selection);
  runtime.setSessionModelSelection(appliedSelection);
  const persisted = (previous?.persisted ?? Promise.resolve()).then(async () => {
    if (runtime.sessionPersisted !== false) {
      await persistRuntimeModelSelection(runtime, appliedSelection);
    }
  });
  selectionAdmissions.set(runtime, {
    sequence: Number.isFinite(intent.admissionSeq)
      ? intent.admissionSeq
      : (previous?.sequence ?? 0),
    commandId: intent.sourceCommandId,
    persisted,
  });
  return persisted;
}

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  return createRuntimeModel(runtime, {
    selection,
  });
}

/**
 * 在 Submission 真正开始执行或 Guide 被下一次 model step 消费时应用其执行配置。
 * 选择只决定新创建的 Model；已经被其他 Loop 持有的 Model 不会被修改。
 *
 * 会话选型在**接纳**时就已经固定（`acceptSubmissionModelSelection`）；这里再调一次只因幂等：
 * 未经接纳入口进来的内部命令照旧在这一刻接纳，但已接纳过的命令不会再倒写。
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  let model = preparedModel;

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
    });
    await acceptSubmissionModelSelection(runtime, intent, traceContext, modelExecution);
    if (modelExecution?.selectionScope !== "execution") {
      // ModelSelected 展示实际 Loop 的切换；接纳只保存意图，不提前创建可调用 Model。
      const previousSelection = publishedSelections.get(runtime);
      recordPublishedModelSelection(runtime, selection);
      if (!sameModelSelection(previousSelection, selection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: selection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: selection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}
