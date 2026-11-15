import { SessionEventType, createSessionEvent } from "../deps.js";
import type { TraceContext, TurnInputIntentMetadata } from "../deps.js";
import { measureUtf8Bytes, previewInput } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { persistSessionInputUpdates } from "./steering-queue-items.js";

/**
 * 队列原地编辑的 intent 事实：正文与选区引用一起改写，delivery/order/provenance 保持入队时的值。
 * 没有 intent 的旧队列项不凭空造一份：调用方仅在显式传 quotes 时使用本函数。
 */
function editedIntent(
  intent: TurnInputIntentMetadata | undefined,
  text: string,
  conversationQuotes: TurnInputIntentMetadata["conversationQuotes"],
): TurnInputIntentMetadata | undefined {
  if (!intent) return undefined;
  // 显式 [] = 用户清空引用：键整体丢弃，与 admission 的“没引用”同形（不留下空数组）。
  const { conversationQuotes: _previousQuotes, ...rest } = intent;
  return {
    ...rest,
    text,
    ...(conversationQuotes && conversationQuotes.length > 0
      ? { conversationQuotes: [...conversationQuotes] }
      : {}),
  };
}

/**
 * （v4 queue 单项编辑）：按 id 替换某排队输入的文本，重发 TurnSteerQueued（同 id）。
 * v4 reducer 的 onTurnSteerQueued 对同 id 原地更新（保位）。未命中 / 无 active turn → false。
 */
export async function editPendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    newText: string;
    /** 队列原地编辑的选区引用：undefined = 保留原值，[] = 清空。 */
    conversationQuotes?: TurnInputIntentMetadata["conversationQuotes"];
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const pendingInput = activeTurn?.pendingInputs.find((item) => item.id === options.pendingInputId);
  if (!activeTurn || !pendingInput) {
    // held 回落：held 项只在事件日志/投影，经投影定位后
    // 重发同 id TurnSteerQueued（v4 reducer 原地更新，保位）。
    const projection = await this.rebuildProjection();
    const held = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === options.pendingInputId,
    );
    if (!held) return false;
    const nextHeldIntent = editedIntent(held.intent, options.newText, options.conversationQuotes);
    // 旧队列项没有 intent 事实：不能凭空造一份去承载 quotes，明确按“未命中”处理。
    if (options.conversationQuotes !== undefined && !nextHeldIntent) return false;
    await persistSessionInputUpdates(this, [
      {
        id: held.pendingInputId,
        text: options.newText,
        ...(nextHeldIntent ? { intent: nextHeldIntent } : {}),
      },
    ]);
    const event = createSessionEvent(
      SessionEventType.TurnSteerQueued,
      this.sessionId,
      {
        pendingInputId: held.pendingInputId,
        input: options.newText,
        inputPreview: previewInput(options.newText),
        inputSize: measureUtf8Bytes(options.newText),
        ...(held.commandKind ? { commandKind: held.commandKind } : {}),
        ...(nextHeldIntent ? { intent: nextHeldIntent } : {}),
        ...(held.toolDisallowlist ? { toolDisallowlist: held.toolDisallowlist } : {}),
        queueLength: projection.pendingSteerInputs.length,
        targetTurnId: held.targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: held.targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  const nextIntent = editedIntent(pendingInput.intent, options.newText, options.conversationQuotes);
  // 没有 intent 的旧队列项无法承载 quotes：不伪造 intent，按未命中收口。
  if (options.conversationQuotes !== undefined && !nextIntent) return false;
  await persistSessionInputUpdates(this, [
    {
      id: pendingInput.id,
      text: options.newText,
      ...(nextIntent ? { intent: nextIntent } : {}),
    },
  ]);
  pendingInput.input = options.newText;
  // 编辑后的 intent 必须回到内存 queue 项：drain/guide 消费时只能读同一份事实。
  if (nextIntent) pendingInput.intent = nextIntent;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      pendingInputId: pendingInput.id,
      queryId: pendingInput.queryId,
      input: options.newText,
      inputPreview: previewInput(options.newText),
      inputSize: measureUtf8Bytes(options.newText),
      ...(pendingInput.commandKind ? { commandKind: pendingInput.commandKind } : {}),
      ...(pendingInput.delivery ? { delivery: pendingInput.delivery } : {}),
      ...(pendingInput.inputPresentation
        ? { inputPresentation: pendingInput.inputPresentation }
        : {}),
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
      queueLength: activeTurn.pendingInputs.length,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * （v4 queue 重排）：把 pendingInputId 移到 beforePendingInputId 之前（null = 移到队尾），
 * 发 TurnSteerReordered(新序)。v4 reducer 按新序重排 queue rows。未命中 → false。
 */
export async function reorderPendingInput(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const fromIndexActive =
    activeTurn?.pendingInputs.findIndex((item) => item.id === options.pendingInputId) ?? -1;
  if (!activeTurn || fromIndexActive < 0) {
    // held 回落：在投影序上重排后发 TurnSteerReordered（v4 reducer 按新序重排）。
    const projection = await this.rebuildProjection();
    const heldIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
    const fromIndex = heldIds.indexOf(options.pendingInputId);
    if (fromIndex < 0) return false;
    heldIds.splice(fromIndex, 1);
    if (options.beforePendingInputId === null) {
      heldIds.push(options.pendingInputId);
    } else {
      const beforeIndex = heldIds.indexOf(options.beforePendingInputId);
      if (beforeIndex < 0) {
        heldIds.push(options.pendingInputId);
      } else {
        heldIds.splice(beforeIndex, 0, options.pendingInputId);
      }
    }
    await persistSessionInputUpdates(
      this,
      heldIds.map((id, queuePosition) => ({ id, queuePosition })),
    );
    const targetTurnId =
      projection.pendingSteerInputs.find((item) => item.pendingInputId === options.pendingInputId)
        ?.targetTurnId ?? projection.pendingSteerInputs[0]!.targetTurnId;
    const event = createSessionEvent(
      SessionEventType.TurnSteerReordered,
      this.sessionId,
      {
        orderedPendingInputIds: heldIds,
        targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  const items = [...activeTurn.pendingInputs];
  const fromIndex = items.findIndex((item) => item.id === options.pendingInputId);
  if (fromIndex < 0) return false;
  const [moved] = items.splice(fromIndex, 1);
  if (!moved) return false;
  if (options.beforePendingInputId === null) {
    items.push(moved);
  } else {
    const beforeIndex = items.findIndex((item) => item.id === options.beforePendingInputId);
    if (beforeIndex < 0) {
      // 目标锚点已消失 → 退回队尾，不丢项。
      items.push(moved);
    } else {
      items.splice(beforeIndex, 0, moved);
    }
  }
  // 只重排数组而不更新 intent.queuePosition，会让 live queue 顺序正确，
  // 但 drain 后 transcript 又写回 admission 时的旧位置，造成冷热投影事实分叉。
  const reorderedItems = items.map((item, index) =>
    item.intent ? { ...item, intent: { ...item.intent, queuePosition: index } } : item,
  );
  await persistSessionInputUpdates(
    this,
    reorderedItems.map((item, queuePosition) => ({ id: item.id, queuePosition })),
  );
  activeTurn.pendingInputs.splice(0, activeTurn.pendingInputs.length, ...reorderedItems);
  const event = createSessionEvent(
    SessionEventType.TurnSteerReordered,
    this.sessionId,
    {
      orderedPendingInputIds: reorderedItems.map((item) => item.id),
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}
