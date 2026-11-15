import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { SessionEventStorePort, SessionStorePort } from "@zcode/contracts";
import { SessionControlError, type CliScope } from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";
import type { CliRootAppRequest } from "./contract.js";
import { CliOperationObservations } from "./observation.js";

const DEFAULT_PAGE_SIZE = 50;
// 读本机会话库的列表只扫描有界窗口，避免一次把全部历史会话行解码进内存。
export const MAX_LISTED_SESSIONS = 2000;
const DEFAULT_MAX_REQUESTS = 4096;
const DEFAULT_MAX_ROOTS = 128;

export interface Root {
  app: ZCodeApp;
  owned: boolean;
  verified: boolean;
  signal: AbortController;
  unsubscribe: () => void;
  completions: Set<Promise<unknown>>;
  prepared: boolean;
  failure?: string;
  preparation?: Promise<void>;
}
export interface RequestReceipt {
  fingerprint: string;
  result: Promise<unknown>;
}

/**
 * manager 的全部可变状态。这里**没有** accepted 输入队列：执行队列仍在 Core 的
 * CommandInbox；本对象只持有 root 责任、幂等回执与 operation 观察快照。
 */
export interface ControlState {
  epoch: string;
  workspace: CliScope;
  sessionStore: SessionStorePort;
  /**
   * rewind 账本所在的事件存储。缺席时读取退化为持久消息（与引入前一致）；
   * 在场则按活动分支裁剪。owner 仍是启动装配传入的那个事件存储，不新建第二份。
   */
  eventStore?: SessionEventStorePort;
  createRootApp(input: CliRootAppRequest): Promise<ZCodeApp>;
  roots: Map<string, Root>;
  receipts: Map<string, RequestReceipt>;
  observations: CliOperationObservations;
  pendingMutations: Set<Promise<unknown>>;
  maxRequests: number;
  maxRoots: number;
  rootReservations: number;
  closing: boolean;
}

export function createControlState(input: {
  workspace: CliScope;
  sessionStore: SessionStorePort;
  eventStore?: SessionEventStorePort;
  limits?: { requests?: number; roots?: number };
  createRootApp(input: CliRootAppRequest): Promise<ZCodeApp>;
}): ControlState {
  const maxRequests = input.limits?.requests ?? DEFAULT_MAX_REQUESTS;
  const maxRoots = input.limits?.roots ?? DEFAULT_MAX_ROOTS;
  if (![maxRequests, maxRoots].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new SessionControlError("invalid_input", "CLI owner capacity must be a positive integer");
  return {
    epoch: randomUUID(),
    workspace: {
      ...input.workspace,
      workspacePath: resolve(input.workspace.workspacePath),
    },
    sessionStore: input.sessionStore,
    ...(input.eventStore ? { eventStore: input.eventStore } : {}),
    createRootApp: input.createRootApp,
    roots: new Map(),
    receipts: new Map(),
    observations: new CliOperationObservations(randomUUID()),
    pendingMutations: new Set(),
    maxRequests,
    maxRoots,
    rootReservations: 0,
    closing: false,
  };
}

export function scopeKey(scope: CliScope): string {
  return scope.workspaceIdentity?.trim() || resolve(scope.workspacePath);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function assertOpen(state: ControlState): void {
  if (state.closing)
    throw new SessionControlError("unavailable", "CLI session control owner is closed");
}
function pageOffset(cursor?: string): number {
  if (cursor === undefined) return 0;
  if (!/^offset:(0|[1-9][0-9]*)$/.test(cursor))
    throw new SessionControlError("invalid_input", "Invalid page cursor");
  const offset = Number(cursor.slice("offset:".length));
  if (!Number.isSafeInteger(offset))
    throw new SessionControlError("invalid_input", "Invalid page cursor");
  return offset;
}
export function page<T>(
  items: T[],
  cursor?: string,
  limit = DEFAULT_PAGE_SIZE,
): { items: T[]; nextCursor?: string } {
  const offset = pageOffset(cursor);
  return {
    items: items.slice(offset, offset + limit),
    ...(offset + limit < items.length ? { nextCursor: `offset:${offset + limit}` } : {}),
  };
}
