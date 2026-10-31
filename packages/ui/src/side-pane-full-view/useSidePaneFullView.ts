import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SidePaneFullViewController,
  SidePaneFullViewFloating,
  SidePaneFullViewState,
  SidePaneFullViewSurface,
} from "@/side-pane-full-view/contract.js";
import {
  SIDE_PANE_FULL_VIEW_ENTER_STATE,
  resolveEffectiveSidePaneFullView,
  shouldClearSidePaneFullViewOnPaneClose,
} from "@/side-pane-full-view/model.js";
import {
  buildTaskSidePaneMemoryKey,
  peekTaskSidePaneFullView,
  saveTaskSidePaneFullView,
} from "@/lib/taskSidePaneMemory.js";

/**
 * 完整视图状态的唯一 owner（spec：docs/specs/side-pane-full-view.md）。
 * 记录按 workspace + 对话 owner 存在 taskSidePaneMemory；这里只镜像当前 owner 的值，
 * 侧栏、面板 tab 栏、浮窗显隐都从返回值只读派生，不回写原有状态。
 */
export function useSidePaneFullView({
  workspacePath,
  workspaceIdentity,
  ownerId,
  isSidePaneOpen,
  enabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  ownerId: string | null;
  isSidePaneOpen: boolean;
  enabled: boolean;
}): SidePaneFullViewController {
  const memoryKey = buildTaskSidePaneMemoryKey({
    workspacePath,
    workspaceIdentity,
    taskId: ownerId,
  });
  // owner 与 workspace 一起构成记录作用域；只按 taskId 记录会在跨 workspace 的同 id 间泄漏。
  const scope = `${memoryKey ?? ""}::${ownerId ?? ""}`;
  const [snapshot, setSnapshot] = useState(() => ({
    scope,
    value: peekTaskSidePaneFullView(memoryKey, ownerId),
  }));
  // owner 切换后先按内存读；只有本 hook 写入时才更新快照，所以内存是唯一事实源。
  const stored =
    snapshot.scope === scope ? snapshot.value : peekTaskSidePaneFullView(memoryKey, ownerId);
  const latestRef = useRef({ memoryKey, ownerId, scope, stored });
  latestRef.current = { memoryKey, ownerId, scope, stored };

  const write = useCallback((value: SidePaneFullViewState | null) => {
    const latest = latestRef.current;
    saveTaskSidePaneFullView(latest.memoryKey, latest.ownerId, value);
    latestRef.current = { ...latest, stored: value };
    setSnapshot({ scope: latest.scope, value });
  }, []);

  // 同一 owner 下面板由开变关（◫、关闭最后一个 tab）即退出完整视图；
  // owner 切换时面板开合随 owner 恢复，不代表用户关闭，不清除任何记录。
  const previousRef = useRef({ scope, isSidePaneOpen });
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { scope, isSidePaneOpen };
    if (
      shouldClearSidePaneFullViewOnPaneClose({
        previousScope: previous.scope,
        scope,
        wasSidePaneOpen: previous.isSidePaneOpen,
        isSidePaneOpen,
        hasRecord: latestRef.current.stored !== null,
      })
    ) {
      write(null);
    }
  }, [isSidePaneOpen, scope, write]);

  const fullView = resolveEffectiveSidePaneFullView({ enabled, isSidePaneOpen, stored });
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // 面板关闭时也写入：shell 的「面板关闭 + 快捷键」路径先落记录再开面板，展开后即生效。
  const enter = useCallback(() => {
    if (!enabledRef.current || latestRef.current.stored) return;
    write(SIDE_PANE_FULL_VIEW_ENTER_STATE);
  }, [write]);
  const exit = useCallback(() => {
    if (latestRef.current.stored) write(null);
  }, [write]);
  const toggle = useCallback(() => {
    if (latestRef.current.stored) {
      write(null);
    } else if (enabledRef.current) {
      write(SIDE_PANE_FULL_VIEW_ENTER_STATE);
    }
  }, [write]);
  const setSurface = useCallback(
    (surface: SidePaneFullViewSurface) => {
      const current = latestRef.current.stored;
      if (current && current.surface !== surface) write({ ...current, surface });
    },
    [write],
  );
  const setFloating = useCallback(
    (floating: SidePaneFullViewFloating) => {
      const current = latestRef.current.stored;
      if (current && current.floating !== floating) write({ ...current, floating });
    },
    [write],
  );

  // controller 会作为 prop 进入 memo 布局组件；每次渲染返回新对象会让 memo 失效。
  return useMemo(
    () => ({ fullView, enabled, enter, exit, toggle, setSurface, setFloating }),
    [enabled, enter, exit, fullView, setFloating, setSurface, toggle],
  );
}
