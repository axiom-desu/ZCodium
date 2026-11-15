import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** 统一鼠标、键盘和触控选区的监听；作用域变化后旧选区不能路由到新任务。 */
export function useTextSelection<T>({
  rootRef,
  enabled,
  frozen = false,
  frozenRef,
  inspect,
  scopeKey,
  observeSelectionChange = false,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  /**
   * 冻结当前快照：菜单里的批注输入框获得焦点会让 window 选区塌缩，
   * 但用户正在写的是“对刚才这段选区的批注”，不能因此把动作菜单关掉。
   */
  frozen?: boolean;
  /**
   * 与 `frozen` 同义的同步标记：选区塌缩事件可能早于 React 重新渲染到达，
   * 因此监听器读 ref 而不只读 state。
   */
  frozenRef?: RefObject<boolean>;
  inspect: () => T | null;
  scopeKey: unknown;
  observeSelectionChange?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ scopeKey: unknown; value: T } | null>(null);
  const frameRef = useRef(0);
  // 冻结标记只经 ref 读取：它不能出现在主 effect 依赖里，否则订阅重建会顺手 close()，
  // 打开批注框的瞬间菜单就会消失（真实 Chromium 回归覆盖）。
  const frozenStateRef = useRef(frozen);
  frozenStateRef.current = frozen;
  const isFrozen = useCallback(
    () => frozenStateRef.current || frozenRef?.current === true,
    [frozenRef],
  );
  const close = useCallback(() => {
    window.cancelAnimationFrame(frameRef.current);
    setSnapshot(null);
  }, []);
  useEffect(() => {
    close();
    const root = rootRef.current;
    if (!root || !enabled) return;
    const schedule = () => {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => {
        if (isFrozen()) return;
        const value = inspect();
        setSnapshot(value ? { scopeKey, value } : null);
      });
    };
    const onKey = (event: KeyboardEvent) => (event.key === "Escape" ? close() : schedule());
    const onSelection = () => {
      if (isFrozen()) return;
      if (window.getSelection()?.isCollapsed) close();
      else if (observeSelectionChange) schedule();
    };
    root.addEventListener("mouseup", schedule);
    root.addEventListener("touchend", schedule, { passive: true });
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onSelection);
    root.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      window.cancelAnimationFrame(frameRef.current);
      root.removeEventListener("mouseup", schedule);
      root.removeEventListener("touchend", schedule);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onSelection);
      root.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [close, enabled, inspect, isFrozen, observeSelectionChange, rootRef, scopeKey]);
  return {
    state: enabled && snapshot && snapshot.scopeKey === scopeKey ? snapshot.value : null,
    close,
  };
}
