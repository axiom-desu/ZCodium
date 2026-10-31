import { useSyncExternalStore } from "react";
import type { IServiceAccessor } from "@zcode/services";

interface SourceSettingsServicesEntry {
  attachmentId: string;
  services: IServiceAccessor;
  dispose: () => void;
  /** 注册时的 Source 连接代际；换代后旧 proxy 不得再被读取。 */
  connectionKey: string;
}

interface RegisterSourceSettingsServicesParams extends Omit<
  SourceSettingsServicesEntry,
  "connectionKey"
> {
  sourceServerId: string;
}

/**
 * Source 级设置 attachment 的 renderer 侧注册表。
 *
 * 同一 Source 共享一次 Host attachment admission：新代注册会释放旧代，
 * 但旧代迟到的 close 只能注销自己，不能删掉当前代（按 entry 身份判等）。
 */
const servicesBySourceServerId = new Map<string, SourceSettingsServicesEntry>();
const listeners = new Set<() => void>();

/** Source 当前连接代际（来自 Source 管理快照的 state + updatedAt）。 */
const connectionKeys = new Map<string, string>();
/** 进行中 admission 的连接代际；跨代迟到的注册只能被丢弃。 */
const admissionConnectionKeys = new Map<string, string>();
const attachmentRequests = new Map<string, Promise<void>>();

function emit(): void {
  for (const listener of listeners) listener();
}

function currentConnectionKey(sourceServerId: string): string {
  return connectionKeys.get(sourceServerId) ?? "";
}

export function registerSourceSettingsServices(
  params: RegisterSourceSettingsServicesParams,
): () => void {
  const { sourceServerId } = params;
  const key = currentConnectionKey(sourceServerId);
  const admissionKey = admissionConnectionKeys.get(sourceServerId);
  // 请求发起后 Source 已换代：晚到的 attachment 属于旧连接，不能被登记为当前代。
  if (admissionKey !== undefined && key !== "" && admissionKey !== key) {
    admissionConnectionKeys.delete(sourceServerId);
    params.dispose();
    return () => undefined;
  }
  admissionConnectionKeys.delete(sourceServerId);
  const entry: SourceSettingsServicesEntry = {
    attachmentId: params.attachmentId,
    services: params.services,
    dispose: params.dispose,
    connectionKey: key,
  };
  const previous = servicesBySourceServerId.get(sourceServerId);
  servicesBySourceServerId.set(sourceServerId, entry);
  previous?.dispose();
  emit();
  return () => {
    if (servicesBySourceServerId.get(sourceServerId) !== entry) return;
    servicesBySourceServerId.delete(sourceServerId);
    entry.dispose();
    emit();
  };
}

export function getSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  if (!sourceServerId) return undefined;
  const entry = servicesBySourceServerId.get(sourceServerId);
  // 代际已前进但注册表还没被回收时，旧 proxy 不能继续冒充当前连接。
  if (!entry || entry.connectionKey !== currentConnectionKey(sourceServerId)) return undefined;
  return entry.services;
}

export function useSourceSettingsServices(
  sourceServerId: string | undefined,
): IServiceAccessor | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getSourceSettingsServices(sourceServerId),
    () => undefined,
  );
}

// 换代清理只在本 store 的 reconcile/invalidateAll 路径内发生；不对外暴露第三写入路径。
function invalidateSourceSettingsServices(sourceServerId: string): void {
  const entry = servicesBySourceServerId.get(sourceServerId);
  // 进行中的 admission 代际保留：换代后它晚到的注册要能被识别为旧代并丢弃。
  if (!entry) return;
  servicesBySourceServerId.delete(sourceServerId);
  entry.dispose();
  emit();
}

/** Source owner/Host 连接被替换：所有旧 Source proxy 都不可再用。 */
export function invalidateAllSourceSettingsServices(): void {
  connectionKeys.clear();
  admissionConnectionKeys.clear();
  attachmentRequests.clear();
  const entries = [...servicesBySourceServerId.values()];
  if (entries.length === 0) return;
  servicesBySourceServerId.clear();
  for (const entry of entries) entry.dispose();
  emit();
}

/**
 * 把 Source 管理快照里的连接代际同步到注册表：断线、重连换代或 Source 消失时
 * 立即释放旧 proxy（不用超时兜底），让选择保持只读并触发新一代 admission。
 */
export function reconcileSourceSettingsConnections(connections: ReadonlyMap<string, string>): void {
  const stale = new Set<string>();
  for (const [sourceServerId, key] of connections) {
    if (connectionKeys.get(sourceServerId) !== key) stale.add(sourceServerId);
    connectionKeys.set(sourceServerId, key);
  }
  for (const sourceServerId of connectionKeys.keys()) {
    if (!connections.has(sourceServerId)) {
      connectionKeys.delete(sourceServerId);
      stale.add(sourceServerId);
    }
  }
  for (const sourceServerId of stale) invalidateSourceSettingsServices(sourceServerId);
}

/**
 * 同一 Source 的配置面板只共享一次 attachment admission；
 * 这里不复制物理连接、不创建 Agent 会话或第二份业务状态。
 */
export function ensureSourceSettingsServices(
  sourceServerId: string,
  connectionKey: string,
  request: (id: string) => Promise<{ attachmentId: string }>,
): Promise<void> {
  // 调用方持有同一 Source 管理快照的最新连接代际；先对齐注册表，避免 effect 顺序
  // 让新一代 admission 被旧代际误判为跨代迟到。
  if (connectionKeys.get(sourceServerId) !== connectionKey)
    connectionKeys.set(sourceServerId, connectionKey);
  const entry = servicesBySourceServerId.get(sourceServerId);
  if (entry && entry.connectionKey !== currentConnectionKey(sourceServerId))
    invalidateSourceSettingsServices(sourceServerId);
  if (getSourceSettingsServices(sourceServerId)) return Promise.resolve();
  const requestKey = `${sourceServerId}\0${connectionKey}`;
  const pending = attachmentRequests.get(requestKey);
  if (pending) return pending;
  admissionConnectionKeys.set(sourceServerId, connectionKey);
  const result = request(sourceServerId)
    .then(() => undefined)
    .catch((error: unknown) => {
      if (admissionConnectionKeys.get(sourceServerId) === connectionKey)
        admissionConnectionKeys.delete(sourceServerId);
      throw error;
    })
    .finally(() => {
      if (attachmentRequests.get(requestKey) === result) {
        attachmentRequests.delete(requestKey);
      }
    });
  attachmentRequests.set(requestKey, result);
  return result;
}
