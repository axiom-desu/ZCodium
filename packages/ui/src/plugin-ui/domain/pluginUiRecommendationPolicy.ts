export interface PluginUiRecommendationTarget {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  sessionId?: string | null;
}

/**
 * 推荐/市场入口的隔离键：身份优先于路径，并把远端会话与正式会话一起纳入。
 * 只由宿主内部使用；下发页面必须改走 pluginUiStateKey 的摘要。
 */
export function buildPluginUiRecommendationTargetKey(target: PluginUiRecommendationTarget): string {
  return JSON.stringify([
    target.workspaceIdentity?.trim() || target.workspacePath || "",
    target.remoteSessionId ?? "",
    target.sessionId ?? "",
  ]);
}

/**
 * 同一 pluginId 只保留首个 surface；重复配置不能在同一入口渲染两次或抢占后加入的面板。
 * 目录尚未加载的条目也不提前占位，避免伪造可用。
 */
export function selectVisibleUiPluginRecommendations<T extends { id: string }>(
  recommendations: readonly { pluginId: string; surfaceId: string }[],
  items: readonly T[],
): Array<{ pluginId: string; surfaceId: string; item: T }> {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const selected: Array<{ pluginId: string; surfaceId: string; item: T }> = [];
  for (const recommendation of recommendations) {
    if (seen.has(recommendation.pluginId)) continue;
    seen.add(recommendation.pluginId);
    const item = itemsById.get(recommendation.pluginId);
    if (item) selected.push({ ...recommendation, item });
  }
  return selected;
}
