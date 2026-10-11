import type { ZCodeMessageWithParts, ZCodeStreamEvent } from "@zcode/shared";

/**
 * 手机远控会话投影的纯函数 reducer。
 *
 * 职责：把 Host replayable 事件流（`agent_message_chunk` / `task_snapshot_updated` /
 * 终态事件）与快照读取结果，规约为稳定的消息气泡列表。订阅本身由 Host 拥有，
 * 本 reducer 不产生任何 IO，也不保存 session 事实，只维护移动端视图态：
 *
 * - **快照屏障**：`beginScope` 与 `task_snapshot_updated` 置 `awaitingSnapshot`，
 *   屏障期间丢弃增量 chunk，等 `applySnapshot` 落地权威历史。这样迟到的流式碎片
 *   不会覆盖已恢复的快照。
 * - **按 messageId 幂等 upsert**：同一 `messageId` 的 chunk 始终落到同一条 assistant
 *   气泡；重复投递（传输层重放）不新增气泡、不重复正文。
 * - **resync 标志**：`bridge-degraded` / 断档 / 快照信号都置 `needsResync`，
 *   由宿主重开 bridge、重订阅并重读快照。
 * - **作用域代际**：每条 action 携带 `scope`（workspace + task），与当前 scope 不一致
 *   的事件直接丢弃，避免切 workspace/task 后的迟到事件污染新会话。
 */

/** 手机会话视图的一条气泡；`id` 稳定，供 React key 与幂等 upsert 复用。 */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** 订阅作用域：workspace + task 任一变化都视为新会话。 */
export interface ConversationScope {
  workspaceKey: string;
  taskId: string;
}

export interface ConversationState {
  scope: ConversationScope | null;
  messages: ConversationMessage[];
  /** 快照屏障：为 true 时丢弃增量 chunk，等 `applySnapshot` 解除。 */
  awaitingSnapshot: boolean;
  /** 需要重读快照：degraded / 断档 / `task_snapshot_updated` / 终态事件。 */
  needsResync: boolean;
  /** `messageId` → 已接受的 chunk 指纹，用于拦截传输层重复投递。 */
  acceptedChunks: Record<string, string[]>;
}

export const initialConversationState: ConversationState = {
  scope: null,
  messages: [],
  awaitingSnapshot: true,
  needsResync: false,
  acceptedChunks: {},
};

export type ConversationAction =
  | { type: "beginScope"; scope: ConversationScope }
  | { type: "applySnapshot"; scope: ConversationScope; messages: ConversationMessage[] }
  | { type: "streamEvent"; scope: ConversationScope; event: ZCodeStreamEvent }
  | { type: "resync"; scope: ConversationScope }
  | { type: "appendOptimisticUserMessage"; scope: ConversationScope; id: string; text: string };

/** `readSessionMessages` 的 `ZCodeMessageWithParts[]` → 纯文本气泡（v1 只渲染文本 part）。 */
export function conversationMessagesFromSnapshot(
  messages: ZCodeMessageWithParts[],
): ConversationMessage[] {
  return messages.map((message) => ({
    id: message.info.messageId,
    role: message.info.role === "user" ? "user" : "assistant",
    text: message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter((value) => value.length > 0)
      .join("\n"),
  }));
}

/** scope 身份比较：workspace + task 全等才算同一会话。 */
export function isSameConversationScope(
  left: ConversationScope | null,
  right: ConversationScope | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.workspaceKey === right.workspaceKey &&
    left.taskId === right.taskId
  );
}

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "beginScope": {
      // 同 scope 重新进入（断线重连 / 重订阅）：保留已渲染气泡，只立屏障要求重读快照。
      if (isSameConversationScope(state.scope, action.scope)) {
        return { ...state, awaitingSnapshot: true, needsResync: true };
      }
      return {
        scope: action.scope,
        messages: [],
        awaitingSnapshot: true,
        needsResync: false,
        acceptedChunks: {},
      };
    }
    case "appendOptimisticUserMessage": {
      if (!isSameConversationScope(state.scope, action.scope)) return state;
      return {
        ...state,
        messages: [...state.messages, { id: action.id, role: "user", text: action.text }],
      };
    }
    case "resync": {
      if (!isSameConversationScope(state.scope, action.scope)) return state;
      return { ...state, needsResync: true, awaitingSnapshot: true };
    }
    case "applySnapshot": {
      if (!isSameConversationScope(state.scope, action.scope)) return state;
      return {
        ...state,
        messages: action.messages,
        awaitingSnapshot: false,
        needsResync: false,
        acceptedChunks: {},
      };
    }
    case "streamEvent": {
      if (!isSameConversationScope(state.scope, action.scope)) return state;
      return reduceStreamEvent(state, action.event);
    }
  }
}

function reduceStreamEvent(state: ConversationState, event: ZCodeStreamEvent): ConversationState {
  // 快照信号：残余数据已 flush，先立屏障、等权威快照，再放行后续增量。
  if (event.type === "task_snapshot_updated") {
    return { ...state, awaitingSnapshot: true, needsResync: true };
  }
  // 终态：再读一次快照对齐最终正文（流式碎片可能不完整）。
  if (event.type === "task_complete" || event.type === "task_error") {
    return { ...state, awaitingSnapshot: true, needsResync: true };
  }
  if (event.type !== "agent_message_chunk") return state;
  // 屏障期间丢弃增量：快照落地后由权威历史补齐，避免碎片覆盖。
  if (state.awaitingSnapshot) return state;
  const content = event.content;
  if (content.length === 0) return state;
  // messageId 缺失时退回 traceId，保证同一轮次的碎片仍归并到同一条气泡。
  const key = event.messageId ?? event.traceId;
  const fingerprint = `${event.inputId ?? ""}\u0000${content}`;
  const accepted = state.acceptedChunks[key] ?? [];
  if (accepted.includes(fingerprint)) return state;

  const index = findAssistantMessageIndex(state.messages, key);
  const nextAcceptedChunks = { ...state.acceptedChunks, [key]: [...accepted, fingerprint] };
  if (index === -1) {
    return {
      ...state,
      messages: [...state.messages, { id: key, role: "assistant", text: content }],
      acceptedChunks: nextAcceptedChunks,
    };
  }
  const existing = state.messages[index];
  if (!existing) return state;
  const messages = [...state.messages];
  messages[index] = { ...existing, text: mergeChunkText(existing.text, content) };
  return { ...state, messages, acceptedChunks: nextAcceptedChunks };
}

function findAssistantMessageIndex(messages: ConversationMessage[], id: string): number {
  return messages.findIndex((message) => message.id === id && message.role === "assistant");
}

/**
 * 合并同一 messageId 的正文：
 * - 新正文是已有正文的前缀扩展（累计式快照）→ 覆盖，避免重复累加；
 * - 否则按增量追加（Host `mapModelStreaming` 的 text_delta 语义）。
 */
function mergeChunkText(existing: string, incoming: string): string {
  if (existing.length === 0) return incoming;
  if (incoming === existing || incoming.startsWith(existing)) return incoming;
  return existing + incoming;
}
