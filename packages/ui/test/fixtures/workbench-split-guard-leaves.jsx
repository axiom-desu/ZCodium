// 分屏守卫组件 E2E 的展示叶子替身：只保留 V4WorkspaceChatArea 下发的
// pane 头分屏回调入口，避免把真实 SessionPane 的会话数据面搬进守卫。
// 守卫逻辑（canCreateWorkbenchSplit / dragover offer / drop 提交重验）仍是生产实现。
export function SessionPane({ paneId, sessionId, onSplitRight, onSplitDown }) {
  return (
    <div
      data-testid="guard-session-pane"
      data-pane-id={paneId}
      data-session-id={sessionId ?? "draft"}
      className="flex h-full min-h-0 flex-col gap-1 p-2"
    >
      <span className="text-sm">session pane</span>
      {onSplitRight ? (
        <button type="button" data-testid="guard-split-right" onClick={onSplitRight}>
          split right
        </button>
      ) : null}
      {onSplitDown ? (
        <button type="button" data-testid="guard-split-down" onClick={onSplitDown}>
          split down
        </button>
      ) : null}
    </div>
  );
}

export function V4PaneConversationProvider({ children }) {
  return children;
}
