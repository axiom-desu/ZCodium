import { resolve } from "node:path";
import { SessionEventType, type MessageWithParts, type SessionId, type SessionInfo } from "@zcode/contracts";
import { SessionControlError } from "@zcode/session-control/contracts";
import type { CliScope, CliSessionRef, SessionSummary } from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";
import { projectActiveSessionMessages } from "../zcode-protocol/server-operations.js";
import { MAX_LISTED_SESSIONS, scopeKey, type ControlState, type Root } from "./models.js";

const ROOT_ACTIONS = [
  "readSession",
  "sendToSession",
  "waitSessions",
  "interruptSession",
  "renameSession",
  "forkSession",
] as const;

const NO_OWNER =
  "No reachable independent CLI owner is registered for this session; history will not be restored";

export function ref(state: ControlState, sessionId: string): CliSessionRef {
  return { ...state.workspace, sessionId };
}
/** 目标是否由本 manager 托管；workspace 不符直接拒绝，跨 workspace 只能走只读全库。 */
export function owner(state: ControlState, session: CliSessionRef): Root {
  if (
    scopeKey(session) !== scopeKey(state.workspace) ||
    resolve(session.workspacePath) !== state.workspace.workspacePath
  )
    throw new SessionControlError("forbidden", "Session workspace does not match this owner");
  const root = state.roots.get(session.sessionId);
  if (!root) throw new SessionControlError("unavailable", NO_OWNER);
  return root;
}
export function writable(state: ControlState, session: CliSessionRef): Root {
  const root = owner(state, session);
  // 关闭责任与来源证明独立；只有来源不明的恢复历史不能反向变成控制目标。
  if (root.failure) throw new SessionControlError("unavailable", root.failure);
  if (!root.verified)
    throw new SessionControlError(
      "unavailable",
      "Session source is not verified as an independent CLI root",
    );
  return root;
}
export function reserveRoot(state: ControlState): void {
  if (state.roots.size + state.rootReservations >= state.maxRoots)
    throw new SessionControlError("unavailable", "CLI root capacity reached");
  state.rootReservations += 1;
}
export function attach(
  state: ControlState,
  app: ZCodeApp,
  owned: boolean,
  verified = true,
): Root {
  const existing = state.roots.get(app.sessionId);
  if (existing) {
    if (existing.app !== app)
      throw new SessionControlError("conflict", "A different runtime already owns this session");
    return existing;
  }
  const root: Root = {
    app,
    owned,
    verified,
    prepared: false,
    signal: new AbortController(),
    completions: new Set(),
    unsubscribe: app.runtime.subscribeEvents({
      onSessionEvent: (event) => state.observations.onEvent(event),
    }),
  };
  state.roots.set(app.sessionId, root);
  return root;
}
export function track(state: ControlState, root: Root, completion: Promise<unknown>): void {
  root.completions.add(completion);
  const settle = () => {
    root.completions.delete(completion);
  };
  void completion.then(settle, settle);
}

// 本机会话库中的任意会话：只读持久事实，不恢复 runtime，也不认领 owner。
export function storedRef(stored: SessionInfo): CliSessionRef {
  return {
    kind: "cli",
    workspacePath: stored.directory,
    ...(stored.workspaceID ? { workspaceIdentity: stored.workspaceID } : {}),
    sessionId: stored.id,
  };
}
// 其他会话只有持久事实：状态未知，只宣称可读，不宣称可写。
export function storedSummary(stored: SessionInfo): SessionSummary<CliSessionRef> {
  return {
    session: storedRef(stored),
    title: stored.title,
    status: "unknown",
    availableActions: ["readSession"],
    updatedAt: new Date(stored.time.updated).toISOString(),
  };
}
export async function readStored(
  state: ControlState,
  sessionId: string,
): Promise<SessionInfo | undefined> {
  const stored = await state.sessionStore.getSession(sessionId as SessionId);
  return stored && !stored.time.deleted ? stored : undefined;
}
/** 只读持久事实：列表按更新时间倒序，标题子串过滤在 manager 侧完成（与 UI 同一判据）。 */
export async function listStored(
  state: ControlState,
  filter?: CliScope,
): Promise<SessionSummary<CliSessionRef>[]> {
  const stored = await state.sessionStore.listSessions({
    roots: true,
    ...(filter ? { directory: resolve(filter.workspacePath) } : {}),
    limit: MAX_LISTED_SESSIONS,
  });
  return Promise.all(
    stored
      .filter((item) => !filter || scopeKey(storedRef(item)) === scopeKey(filter))
      .map(async (item) => {
        const root = state.roots.get(item.id);
        return root?.verified ? summary(state, root) : storedSummary(item);
      }),
  );
}
export async function summary(
  state: ControlState,
  root: Root,
): Promise<SessionSummary<CliSessionRef>> {
  const stored = await state.sessionStore.getSession(root.app.sessionId);
  if (stored?.time.deleted)
    throw new SessionControlError("unavailable", "Session has been deleted");
  const executionId = root.app.runtime.getActiveForegroundExecutionId();
  return {
    session: ref(state, root.app.sessionId),
    title: stored?.title ?? "New session",
    status:
      state.observations.statusForSession(root.app.sessionId) ??
      (root.app.runtime.hasActiveOrQueuedTurnWork() ? "running" : "idle"),
    availableActions: root.failure ? ["readSession"] : root.verified ? [...ROOT_ACTIONS] : [],
    ...(stored ? { updatedAt: new Date(stored.time.updated).toISOString() } : {}),
    ...(executionId ? { executionId } : {}),
  };
}
/**
 * 读持久消息并投影到**当前活动分支**。
 *
 * rewind 账本（`RewindTriggered` 事件）是唯一裁剪依据，投影复用 Host 既有的
 * `projectActiveSessionMessages`：会话控制工具读到的消息必须与 GUI/协议读取一致，
 * 否则被回滚的旧分支会通过工具结果复活。没有事件存储（或历史会话没有 rewind 账本）时
 * 行为与引入前完全一致。
 */
export async function readPersistedMessages(
  state: ControlState,
  stored: SessionInfo,
): Promise<MessageWithParts[]> {
  const messages = await state.sessionStore.messages({ sessionID: stored.id });
  const eventStore = state.eventStore;
  if (!eventStore) return messages;
  const events = await eventStore.getEvents(stored.id as SessionId);
  const rewindEvents = events.filter((event) => event.type === SessionEventType.RewindTriggered);
  if (rewindEvents.length === 0) return messages;
  return projectActiveSessionMessages(messages, stored, rewindEvents);
}
