import type { IPluginManagementService } from "@zcode/services";
import { type ZCodePluginScope } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildWorkspaceKey(
  workspacePath: string,
  workspaceIdentity: string | null,
  authorityKey: string | null,
  remoteSessionId: string | null = null,
): string {
  return `${authorityKey?.trim() || "workspace"}\0${workspaceIdentity?.trim() || workspacePath}\0${remoteSessionId ?? ""}`;
}

// 只共享同服务、同身份、同配置投影的在途查询；每个视图仍独立写回和保存错误态。
const loadsByService = new WeakMap<
  IPluginManagementService,
  Map<string, { task: Promise<Partial<PluginManagementState>> }>
>();
// 单个 operationId 会被后一次安装覆盖；每次调用持有独立条目，完成时只移除自己。
// 通过条目身份清理，同名并发操作以及切换配置层后的新操作都不会被误清除。
export function beginPluginOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  id: string,
): () => void {
  const entry = { id };
  set({
    activeOperations: [...get().activeOperations, entry],
    operationId: id,
    operationVersion: get().operationVersion + 1,
    error: null,
    lastFailedPluginId: null,
  });
  return () => {
    const activeOperations = get().activeOperations.filter((operation) => operation !== entry);
    const wasLatest = get().operationId === id;
    set({
      activeOperations,
      // 旧操作结束时只清理自己的可见投影；仍有并发操作时保留最近一个作为旧入口的忙碌态。
      ...(wasLatest ? { operationId: activeOperations.at(-1)?.id ?? null } : {}),
    });
  };
}

export async function runWorkspaceOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginService: IPluginManagementService,
  operationId: string,
  operation: (workspace: { workspacePath: string; workspaceIdentity?: string }) => Promise<void>,
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, remoteSessionId, authorityKey, configScope } = get();
  if (!workspacePath) return false;
  const finish = beginPluginOperation(set, get, operationId);
  const operationVersion = get().operationVersion;
  const isCurrentContext = (): boolean => {
    const current = get();
    return (
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.remoteSessionId === remoteSessionId &&
      current.authorityKey === authorityKey &&
      current.configScope === configScope
    );
  };
  const ownsVisibleOperation = (): boolean =>
    isCurrentContext() && get().operationVersion === operationVersion;
  try {
    await operation({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    // 并发刷新不能把已成功落盘的安装报告成失败；结果只受当前目标上下文约束。
    if (!isCurrentContext()) return false;
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      authorityKey,
      configScope,
      pluginService,
      fresh: true,
    });
    return isCurrentContext();
  } catch (error) {
    // marketplace add/update 等通用操作失败：无插件目标，归属清空。
    logger.error("[plugins] operation failed", { operationId, error: toMessage(error) });
    // 旧操作不能覆盖同一配置层中新操作的错误态；只有最近发起的操作才回写。
    if (ownsVisibleOperation()) {
      set({ error: toMessage(error), lastFailedPluginId: null });
    }
    return false;
  } finally {
    finish();
  }
}

interface PluginLoadParams {
  workspacePath: string;
  workspaceIdentity: string | null;
  remoteSessionId: string | null;
  authorityKey: string | null;
  configScope: ZCodePluginScope | null;
  pluginService: IPluginManagementService;
  fresh?: boolean;
  background?: boolean;
}
export async function loadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: PluginLoadParams,
): Promise<void> {
  let inFlightLoads = loadsByService.get(params.pluginService);
  if (!inFlightLoads) {
    inFlightLoads = new Map();
    loadsByService.set(params.pluginService, inFlightLoads);
  }
  const workspaceKey = buildWorkspaceKey(
    params.workspacePath,
    params.workspaceIdentity,
    params.authorityKey,
    params.remoteSessionId,
  );
  const loadKey = `${workspaceKey}\0${params.configScope ?? "effective"}`;
  const existing = inFlightLoads.get(loadKey);
  // 变更前启动的查询不能充当变更后的刷新；同一轮通知的新查询仍可共用。
  if (existing && params.fresh) {
    await existing.task;
    return loadInto(set, get, { ...params, fresh: false });
  }
  const request = existing ?? { task: runLoadInto({ ...params, workspaceKey }) };
  inFlightLoads.set(loadKey, request);
  try {
    const result = await request.task;
    const current = get();
    if (
      current.workspacePath !== params.workspacePath ||
      current.workspaceIdentity !== params.workspaceIdentity ||
      current.remoteSessionId !== params.remoteSessionId ||
      current.authorityKey !== params.authorityKey ||
      current.configScope !== params.configScope
    )
      return;
    // 其它视图的成功操作只刷新数据，不能抹掉本视图尚未处理的操作错误。
    set(
      params.background && current.error
        ? { ...result, error: current.error, lastFailedPluginId: current.lastFailedPluginId }
        : result,
    );
  } finally {
    if (inFlightLoads.get(loadKey) === request) inFlightLoads.delete(loadKey);
  }
}

async function runLoadInto(
  params: PluginLoadParams & { workspaceKey: string },
): Promise<Partial<PluginManagementState>> {
  try {
    // React StrictMode、settings service 引用刷新或快速切换设置页时，
    // 同一 workspace 会并发触发 initialize。每次触发都发成独立 plugins/list 的话，
    // agent 已经 stale 时这些请求会排队产生多个 30s timeout。按 workspaceKey 复用 in-flight
    // 请求，并在仍处于同一 workspace 时才回写结果，避免过期响应覆盖当前设置页。
    const [listResult, overviewResult] = await Promise.all([
      params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
      params.pluginService.getPluginsOverview({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    ]);
    const diagnostics = [...listResult.diagnostics, ...overviewResult.diagnostics];
    return {
      plugins: listResult.plugins,
      marketplaces: overviewResult.marketplaces,
      marketplaceAvailabilityKnown: true,
      availablePlugins: overviewResult.availablePlugins,
      installedPlugins: overviewResult.installedPlugins,
      restorableBuiltins: overviewResult.restorableBuiltins,
      diagnostics,
      loading: false,
    };
  } catch (error) {
    logger.error("[plugins] overview/list failed", {
      workspacePath: params.workspacePath,
      workspaceKey: params.workspaceKey,
      lastFailedPluginId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const result = await params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      });
      return {
        plugins: result.plugins,
        marketplaces: [],
        // overview 失败时空数组表示“来源状态未知”，而不是“所有来源已删除”。
        // 保留该边界，避免 list fallback 返回的 official/cache 插件被批量误判为孤立安装。
        marketplaceAvailabilityKnown: false,
        availablePlugins: [],
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: result.diagnostics,
        loading: false,
      };
    } catch (listError) {
      logger.error("[plugins] list fallback failed", {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspaceKey,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
      return {
        loading: false,
        marketplaceAvailabilityKnown: false,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      };
    }
  }
}
