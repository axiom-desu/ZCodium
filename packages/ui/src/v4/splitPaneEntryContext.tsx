// 侧栏会话项「在分屏打开 / 拖拽分屏」入口的可用性开关。
// session workbench groups 支持桌面和普通 web app；手机与 /remote web-remote
// 不启用。用 context 而不是逐层 props：会话项上下文菜单和 drag source 被多个
// 侧栏 Section 共用，判定源收敛在 WorkspaceShellLayout 一处。
//
// 完整视图生效期间禁止新建分屏；shell 从现有 full view controller 只读派生出
// 唯一 `enabled` 值，经同一个 Provider value 同时下发给侧栏（菜单/拖拽源）与
// 对话区（pane 头按钮、dragover offer、drop 提交），不持久化第二份开关。
import { createContext, useContext, useMemo, useRef } from "react";
import type { WorkbenchSessionTarget } from "@/v4/workbenchSessionPlacement.js";

export type V4SplitPaneSessionTarget = WorkbenchSessionTarget;

interface V4SplitPaneEntryContextValue {
  readonly enabled: boolean;
  readonly canOpenSession: (target: V4SplitPaneSessionTarget) => boolean;
  readonly openSession: (target: V4SplitPaneSessionTarget) => void;
}

const DEFAULT_SPLIT_PANE_ENTRY_CONTEXT: V4SplitPaneEntryContextValue = {
  enabled: false,
  canOpenSession: () => false,
  openSession: () => {},
};

export const V4SplitPaneEntryContext = createContext<V4SplitPaneEntryContextValue>(
  DEFAULT_SPLIT_PANE_ENTRY_CONTEXT,
);

/**
 * 由 shell 调用一次，再把同一个 value 交给多个 Provider 作用域（侧栏、对话区）。
 * controller 存 ref：回调变化不重建 context，避免无关子树重渲染。
 */
export function useV4SplitPaneEntryValue({
  enabled,
  canOpenSession,
  onOpenSession,
}: {
  enabled: boolean;
  canOpenSession: (target: V4SplitPaneSessionTarget) => boolean;
  onOpenSession: (target: V4SplitPaneSessionTarget) => void;
}): V4SplitPaneEntryContextValue {
  const controllerRef = useRef({ canOpenSession, onOpenSession });
  controllerRef.current = { canOpenSession, onOpenSession };
  return useMemo<V4SplitPaneEntryContextValue>(
    () => ({
      enabled,
      canOpenSession: (target) => enabled && controllerRef.current.canOpenSession(target),
      openSession: (target) => {
        if (enabled) controllerRef.current.onOpenSession(target);
      },
    }),
    [enabled],
  );
}

/** 右键入口由 shell 统一裁决，避免 task row 绕过 active group/draft pane owner。 */
export function useV4SplitPaneEntry(): V4SplitPaneEntryContextValue {
  return useContext(V4SplitPaneEntryContext);
}
