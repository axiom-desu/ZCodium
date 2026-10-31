import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  buildStoreItems,
  isItemBusy,
  isUiPluginItem,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { useUiPluginRecommendations } from "@/plugin-ui/adapters/useUiPluginRecommendations.js";
import {
  buildPluginUiRecommendationTargetKey,
  selectVisibleUiPluginRecommendations,
  type PluginUiRecommendationTarget,
} from "@/plugin-ui/domain/pluginUiRecommendationPolicy.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { logger } from "@/logger.js";

interface RecommendedUiPluginTarget extends PluginUiRecommendationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string | null;
}

/** 推荐曝光读取完整市场目录；安装和启用继续由现有管理 store 与 CLI 负责。 */
export function useRecommendedUiPlugins(target: RecommendedUiPluginTarget) {
  const {
    pluginManagementService: service,
    skillsService,
    pluginUiBridgeService: bridge,
  } = useServices();
  const store = useScopedPluginManagementStore(service);
  const state = store();
  const targetKey = buildPluginUiRecommendationTargetKey(target);
  const { recommendations, loading: configLoading } = useUiPluginRecommendations(
    target.sessionId !== null,
    targetKey,
  );
  const context = useMemo(() => ({ key: targetKey, service }), [targetKey, service]);
  const current = useRef<typeof context | null>(context);
  current.current = context;
  const [ready, setReady] = useState<typeof context>();
  const [failure, setFailure] = useState<{
    context: typeof context;
    message: string;
  }>();
  useEffect(() => {
    let active = true;
    current.current = context;
    setReady(undefined);
    if (service && target.sessionId !== null) {
      void store
        .getState()
        .initialize({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          remoteSessionId: target.remoteSessionId,
          pluginService: service,
        })
        .then(() => {
          // A 的初始化晚于切到 B 时只能丢弃，不能覆盖 B 的目录/忙碌态。
          if (active && current.current === context) setReady(context);
        });
    }
    return () => {
      active = false;
      current.current = null;
    };
  }, [
    context,
    service,
    store,
    target.remoteSessionId,
    target.workspaceIdentity,
    target.workspacePath,
    target.sessionId,
  ]);
  const items = ready === context ? buildStoreItems(state) : [];
  // 本仓没有无账号推荐配置端点：配置为空时从实际内置/已安装目录回退到真实 UI 插件，
  // 仍只展示确已存在的 surface；目录也没有 UI 插件时保持空态。
  const fallbackRecommendations = items.flatMap((item) => {
    const surface = item.info?.uiSurfaces?.[0];
    return isUiPluginItem(item) && surface ? [{ pluginId: item.id, surfaceId: surface.id }] : [];
  });
  const entries = selectVisibleUiPluginRecommendations(
    recommendations.length > 0 ? recommendations : fallbackRecommendations,
    items,
  );
  const isCurrent = () => current.current === context;
  const prepare = async (item: StorePluginItem) => {
    // 读取 store 的即时状态，同插件重复点击被拦截，其他插件不受影响。
    if (!isCurrent() || !service || isItemBusy(item, store.getState())) return false;
    setFailure(undefined);
    try {
      const management = store.getState();
      const succeeded = !item.installed
        ? item.restorable
          ? await management.restoreBuiltin(item.id, service)
          : await management.installPlugin(item.name, item.marketplace, service, "user")
        : await management.setEnabled(item.id, true, service, "workspace");
      if (!succeeded) {
        const message = store.getState().error;
        if (message && isCurrent()) setFailure({ context, message });
        return false;
      }
      if (!item.installed) {
        // 与设置页同一技能刷新入口；成功只刷新态，不替用户打开面板。
        await refreshSharedSkillStoreForWorkspace({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          skillsService,
        });
      }
      return isCurrent();
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[plugin-ui] 推荐插件操作失败", { pluginId: item.id, message });
        setFailure({ context, message });
      }
      return false;
    }
  };
  const resolveSurface = async (pluginId: string, surfaceId: string) => {
    if (!bridge) return null;
    try {
      const surfaces = await bridge.listSurfaces({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
      // 入口已经切走：返回 undefined 让调用方不导航、不弹 toast。
      if (!isCurrent()) return undefined;
      return (
        surfaces.find((surface) => surface.pluginId === pluginId && surface.id === surfaceId) ??
        null
      );
    } catch (error) {
      if (!isCurrent()) return undefined;
      logger.warn("[plugin-ui] 推荐面板读取失败", { pluginId, message: String(error) });
      return null;
    }
  };
  return {
    entries,
    loading:
      target.sessionId !== null && (configLoading || (Boolean(service) && ready !== context)),
    resolveSurface,
    prepare,
    isBusy: (item: StorePluginItem) => isItemBusy(item, state),
    error: failure?.context === context ? failure.message : null,
  };
}
