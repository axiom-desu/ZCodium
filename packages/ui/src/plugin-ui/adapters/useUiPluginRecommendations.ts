import { useEffect, useState } from "react";
import type { ClientConfigSnapshot } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/**
 * 缓存和请求合并归 Host 配置服务；此处只持有当前入口的展示投影。
 * targetKey 变化（工作区/会话/远端换代）时旧响应必须丢弃，不能把 A 的推荐带到 B。
 */
export function useUiPluginRecommendations(enabled: boolean, targetKey = "") {
  const service = useOptionalServices()?.clientConfigService;
  const [snapshot, setSnapshot] = useState<{
    service: typeof service;
    targetKey: string;
    recommendations: ClientConfigSnapshot["uiPluginRecommendations"];
  }>();
  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    if (enabled && service) {
      void service.getSnapshot().then(
        ({ uiPluginRecommendations }) => {
          if (active) {
            setSnapshot({ service, targetKey, recommendations: uiPluginRecommendations ?? [] });
          }
        },
        () => {
          if (active) {
            setSnapshot({ service, targetKey, recommendations: [] });
            logger.warn("[plugin-ui] 推荐配置读取失败");
          }
        },
      );
    }
    // 服务/入口/目标切换后，旧请求不能重新发布推荐。
    return () => {
      active = false;
    };
  }, [enabled, service, targetKey]);
  const current =
    enabled && snapshot && snapshot.service === service && snapshot.targetKey === targetKey
      ? snapshot
      : undefined;
  // 空数组不能区分尚未返回与确认无推荐，避免冷启动先闪空态。
  return {
    recommendations: current?.recommendations ?? [],
    loading: enabled && Boolean(service) && !current,
  };
}
