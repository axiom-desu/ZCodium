import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { SettingsSearchId } from "@/settings-search/settingsSearchIndex.js";

/**
 * 搜索结果定位目标。`SettingsPage` 是唯一持有者；`SettingsRow` 在实际挂载时消费它。
 * 目标保留（不因高亮到期而清除），这样同一行再次被选中时能重新滚动/重新计时。
 */
export const SettingsSearchTargetContext = createContext<{ id: SettingsSearchId } | null>(null);

export function useSettingsSearchTarget(id: SettingsSearchId | undefined) {
  const target = useContext(SettingsSearchTargetContext);
  const ref = useRef<HTMLDivElement>(null);
  const [expiredTarget, setExpiredTarget] = useState<typeof target>(null);
  const matched = id !== undefined && target?.id === id;
  const highlighted = matched && expiredTarget !== target;
  useEffect(() => {
    if (!matched) return;
    // 分区可能异步挂载；由真实设置行消费目标，避免定时滚动抢在控件出现之前。
    ref.current?.scrollIntoView({ block: "center", behavior: "auto" });
    ref.current?.focus({ preventScroll: true });
    // 导航目标会保留，直接用它控制底色会让高亮常驻。仅让本次提示到期，
    // 不清除导航或焦点；按目标对象区分轮次，旧回调不会清掉再次命中的高亮。
    const timer = window.setTimeout(() => setExpiredTarget(target), 2000);
    return () => window.clearTimeout(timer);
  }, [matched, target]);
  return { ref, highlighted };
}
