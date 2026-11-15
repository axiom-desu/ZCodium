import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type {
  DataSyncWorkspaceMapping,
  DeviceSyncResult,
  SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { DataSyncCategoryId } from "../contract.js";
import { aggregateDeviceSyncResult } from "../domain/compareBatches.js";
import { loadDataSyncCategory } from "./dataSyncCategoryLoad.js";
import { DATA_SYNC_OFFLINE_ERROR, StalePushError, dataSyncErrorMessage } from "./dataSyncErrors.js";
import { ensureDataSyncHashCache, type DataSyncHashCache } from "./dataSyncHashCache.js";
import { pushDataSyncCategory } from "./dataSyncPush.js";
import type { DataSyncCategoryAdapter, DataSyncAfterPushContext } from "./categories.js";
import type { DataSyncPushControl } from "./pluginCategorySync.js";
import type { DataSyncCategoryView, DataSyncPushAllState, DataSyncPushOutcome } from "./types.js";

/** 一次推送（单个分类或推送全部）。断线时被作废，迟到结果按 session 身份丢弃。 */
interface PushSession {
  kind: "category" | "all";
  outcomes: DataSyncPushOutcome[];
  activeCategory?: DataSyncCategoryId;
}

function createInitialView(id: DataSyncCategoryId): DataSyncCategoryView {
  return {
    id,
    phase: "loading",
    rows: [],
    localCount: 0,
    remoteCount: 0,
    sourceKeys: new Set(),
    targetKeys: new Set(),
    selected: new Set(),
    push: "idle",
    itemErrors: {},
    failedCount: 0,
    stoppable: new Set(),
  };
}

interface DataSyncDialogStateParams {
  categories: readonly DataSyncCategoryAdapter[];
  sourceServerId: string;
  sourceServices: IServiceAccessor | undefined;
  targetServices: IServiceAccessor | undefined;
  online: boolean;
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
  workspaceTabs?: readonly WorkspaceTabState[];
  /** 只传给来源端（哈希与导出）；弹窗打开期间不变。 */
  workspace?: DataSyncWorkspaceMapping;
  onPushFinished(result: DeviceSyncResult): void | Promise<void>;
}

/**
 * 数据同步弹窗状态 owner。
 *
 * generation：弹窗绑定设备的一次连接。`online && targetServices` 换代（断线、重连、attachment 换代）
 * 时递增 generation：断线则禁用操作并把进行中的推送标为失败；重连则清空目标端哈希缓存并重新加载。
 * 所有异步结果在落盘到状态前核对 generation / push session，旧连接的迟到结果一律丢弃。
 */
export function useDataSyncDialog(params: DataSyncDialogStateParams) {
  const { categories, sourceServices } = params;
  const connection = params.online ? params.targetServices : undefined;
  const [views, setViews] = useState<Record<string, DataSyncCategoryView>>(() =>
    Object.fromEntries(categories.map((category) => [category.id, createInitialView(category.id)])),
  );
  const [pushAllState, setPushAllState] = useState<DataSyncPushAllState>("idle");
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const generationRef = useRef(0);
  const connectionRef = useRef(connection);
  const sessionRef = useRef<PushSession | null>(null);
  /** 当前推送分类中可停止项的停止回调；推送结束或作废时清空。 */
  const stoppersRef = useRef<Map<string, () => void> | null>(null);
  /** 推送后刷新的串行队列：按推送顺序执行，不属于 push session，推送不等待它。 */
  const afterPushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sourceCacheRef = useRef(new Map<DataSyncCategoryId, DataSyncHashCache>());
  const targetCacheRef = useRef(new Map<DataSyncCategoryId, DataSyncHashCache>());
  const latestParamsRef = useRef(params);
  latestParamsRef.current = params;

  const updateView = useCallback(
    (id: DataSyncCategoryId, update: (view: DataSyncCategoryView) => DataSyncCategoryView) => {
      setViews((current) => {
        const view = current[id];
        return view ? { ...current, [id]: update(view) } : current;
      });
    },
    [],
  );

  const loadCategory = useCallback(
    async (category: DataSyncCategoryAdapter, mode: "initial" | "refresh") => {
      const generation = generationRef.current;
      const target = connectionRef.current;
      if (!sourceServices || !target) return;
      if (mode === "initial") {
        updateView(category.id, (view) => ({ ...view, phase: "loading", error: undefined }));
      }
      const result = await loadDataSyncCategory({
        category,
        sourceServices,
        targetServices: target,
        workspace: latestParamsRef.current.workspace,
        sourceCache: ensureDataSyncHashCache(sourceCacheRef.current, category.id),
        targetCache: ensureDataSyncHashCache(targetCacheRef.current, category.id),
        isCurrent: () => generation === generationRef.current,
      });
      if (result.kind === "stale") return;
      if (result.kind === "unsupported") {
        logger.info("[DataSync] 设备不支持该分类（旧 Server 缺方法）", { category: category.id });
        updateView(category.id, (view) => ({
          ...view,
          phase: "unsupported",
          error: undefined,
          unsupportedReason: "agent-method-missing",
          rows: [],
          selected: new Set(),
        }));
        return;
      }
      if (result.kind === "error") {
        logger.warn("[DataSync] 加载分类失败", { category: category.id, error: result.error });
        updateView(category.id, (view) => ({
          ...view,
          phase: "error",
          error: result.error,
        }));
        return;
      }
      const selectable = new Set(result.rows.filter((row) => row.selectable).map((row) => row.key));
      updateView(category.id, (view) => ({
        ...view,
        phase: "ready",
        error: undefined,
        unsupportedReason: undefined,
        rows: result.rows,
        localCount: result.localCount,
        remoteCount: result.remoteCount,
        sourceKeys: result.sourceKeys,
        targetKeys: result.targetKeys,
        // 首次加载用默认勾选；推送后刷新保留用户仍可勾选的选择（失败项留着便于「再次同步」）。
        selected:
          mode === "initial"
            ? new Set(result.rows.filter((row) => row.defaultSelected).map((row) => row.key))
            : new Set([...view.selected].filter((key) => selectable.has(key))),
      }));
    },
    [sourceServices, updateView],
  );

  /**
   * 断线或换代：作废进行中的推送，当前分类标为失败，并按一次推送结束写入设备同步状态。
   * 推送中设备断开直接写 failed，不按条目汇总（否则前序分类成功时会写成 partial）。
   */
  const abandonActiveSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    stoppersRef.current = null;
    if (session.activeCategory) {
      updateView(session.activeCategory, (view) =>
        view.push === "pushing"
          ? { ...view, push: "failed", pushError: DATA_SYNC_OFFLINE_ERROR, stoppable: new Set() }
          : view,
      );
    }
    setPushAllState("idle");
    logger.info("[DataSync] 推送中设备断开，结果作废", {
      sourceServerId: latestParamsRef.current.sourceServerId,
    });
    void latestParamsRef.current.onPushFinished("failed");
  }, [updateView]);

  useEffect(() => {
    generationRef.current += 1;
    connectionRef.current = connection;
    abandonActiveSession();
    if (!connection) return;
    targetCacheRef.current.clear();
    for (const category of categories) void loadCategory(category, "initial");
  }, [abandonActiveSession, categories, connection, loadCategory]);

  /**
   * 推送后刷新只刷新运行态，不是导入成功的条件：放进弹窗内的串行队列，不阻塞推送收口，
   * 也不阻塞 onPushFinished（设备同步状态写入）。串行保持各分类刷新先后，失败只记日志。
   */
  const scheduleAfterPush = useCallback(
    (category: DataSyncCategoryAdapter, target: IServiceAccessor): void => {
      const context: DataSyncAfterPushContext = {
        sourceServerId: latestParamsRef.current.sourceServerId,
        targetServices: target,
        workspaceHistory: latestParamsRef.current.workspaceHistory,
        workspaceTabs: latestParamsRef.current.workspaceTabs,
      };
      afterPushQueueRef.current = afterPushQueueRef.current
        .then(() => category.afterPush?.(context))
        .catch((error: unknown) =>
          logger.warn("[DataSync] 推送后刷新失败", {
            category: category.id,
            error: dataSyncErrorMessage(error),
          }),
        );
    },
    [],
  );

  const runCategoryPush = useCallback(
    async (
      category: DataSyncCategoryAdapter,
      session: PushSession,
    ): Promise<DataSyncPushOutcome> => {
      // 断线作废 session 后，推送全部的旧循环必须立刻停止，不能拿新连接把分类标成「推送中」。
      if (sessionRef.current !== session) throw new StalePushError();
      const view = viewsRef.current[category.id];
      const target = connectionRef.current;
      if (!view || !sourceServices || !target) return { succeeded: 0, failed: 0 };
      const rows = view.rows.filter((row) => row.selectable && view.selected.has(row.key));
      if (rows.length === 0) return { succeeded: 0, failed: 0 };
      const stoppers = new Map<string, () => void>();
      stoppersRef.current = stoppers;
      const control: DataSyncPushControl = {
        setStoppable(key: string, stop: (() => void) | null) {
          if (sessionRef.current !== session || stoppersRef.current !== stoppers) return;
          if (stop) stoppers.set(key, stop);
          else stoppers.delete(key);
          const keys = new Set(stoppers.keys());
          updateView(category.id, (current) => ({ ...current, stoppable: keys }));
        },
      };
      const assertAlive = () => {
        if (sessionRef.current !== session) throw new StalePushError();
      };
      session.activeCategory = category.id;
      updateView(category.id, (current) => ({
        ...current,
        push: "pushing",
        pushError: undefined,
        itemErrors: {},
        failedCount: 0,
      }));
      try {
        const outcome = await pushDataSyncCategory({
          category,
          sourceServices,
          targetServices: target,
          workspace: latestParamsRef.current.workspace,
          rows,
          allRows: view.rows,
          control,
          assertAlive,
        });
        assertAlive();
        // 推送后只重算受影响的项：目标端这些 key 的哈希缓存作废（冲突项同样作废，避免反复冲突）。
        const targetCache = ensureDataSyncHashCache(targetCacheRef.current, category.id);
        for (const row of rows) targetCache.delete(row.key);
        updateView(category.id, (current) => ({
          ...current,
          push: outcome.failed > 0 ? "failed" : "done",
          itemErrors: outcome.itemErrors,
          failedCount: outcome.failed,
        }));
        logger.info("[DataSync] 分类推送完成", {
          sourceServerId: latestParamsRef.current.sourceServerId,
          category: category.id,
          succeeded: outcome.succeeded,
          failed: outcome.failed,
        });
        scheduleAfterPush(category, target);
        void loadCategory(category, "refresh");
        return outcome;
      } catch (error) {
        // 旧 session 的 RPC 在重连后才 reject：一律丢弃，不能覆盖新 session 的「推送中」并放开关闭。
        if (error instanceof StalePushError || sessionRef.current !== session) {
          throw new StalePushError();
        }
        const message = dataSyncErrorMessage(error);
        logger.warn("[DataSync] 分类推送失败", { category: category.id, error: message });
        updateView(category.id, (current) => ({
          ...current,
          push: "failed",
          pushError: message,
          failedCount: rows.length,
        }));
        return { succeeded: 0, failed: rows.length };
      } finally {
        if (stoppersRef.current === stoppers) {
          stoppersRef.current = null;
          updateView(category.id, (current) => ({ ...current, stoppable: new Set() }));
        }
      }
    },
    [loadCategory, scheduleAfterPush, sourceServices, updateView],
  );

  const runSession = useCallback(
    async (kind: PushSession["kind"], targets: readonly DataSyncCategoryAdapter[]) => {
      if (sessionRef.current || !connectionRef.current) return;
      const session: PushSession = { kind, outcomes: [] };
      sessionRef.current = session;
      if (kind === "all") setPushAllState("pushing");
      try {
        for (const category of targets) {
          session.outcomes.push(await runCategoryPush(category, session));
        }
      } catch (error) {
        if (error instanceof StalePushError) return;
        throw error;
      }
      if (sessionRef.current !== session) return;
      sessionRef.current = null;
      const result = aggregateDeviceSyncResult(session.outcomes);
      if (kind === "all") setPushAllState(result === "success" ? "done" : "idle");
      await latestParamsRef.current.onPushFinished(result);
    },
    [runCategoryPush],
  );

  const pushCategory = useCallback(
    (id: DataSyncCategoryId) => {
      const category = categories.find((candidate) => candidate.id === id);
      if (category) void runSession("category", [category]);
    },
    [categories, runSession],
  );

  /** 推送全部：只执行有勾选项的分类，按分类串行。 */
  const pushAll = useCallback(() => {
    const targets = categories.filter(
      (category) => (viewsRef.current[category.id]?.selected.size ?? 0) > 0,
    );
    if (targets.length > 0) void runSession("all", targets);
  }, [categories, runSession]);

  /** 按行「停止」：只作用于当前推送分类中处于目标端 add / install 阶段的该项。 */
  const stopItem = useCallback((id: DataSyncCategoryId, key: string) => {
    if (sessionRef.current?.activeCategory !== id) return;
    stoppersRef.current?.get(key)?.();
  }, []);

  const setSelection = useCallback(
    (id: DataSyncCategoryId, keys: Iterable<string>) => {
      setPushAllState((state) => (state === "done" ? "idle" : state));
      updateView(id, (view) => {
        const selectable = new Set(view.rows.filter((row) => row.selectable).map((row) => row.key));
        return { ...view, selected: new Set([...keys].filter((key) => selectable.has(key))) };
      });
    },
    [updateView],
  );

  const pushing = useMemo(
    () =>
      Object.values(views).some((view) => view.push === "pushing") || pushAllState === "pushing",
    [pushAllState, views],
  );

  return {
    views,
    /** online 且 attachment 已就绪；否则禁用操作（离线提示由调用方按 online 显示）。 */
    connected: Boolean(connection),
    pushing,
    pushAllState,
    setSelection,
    pushCategory,
    pushAll,
    stopItem,
  };
}
