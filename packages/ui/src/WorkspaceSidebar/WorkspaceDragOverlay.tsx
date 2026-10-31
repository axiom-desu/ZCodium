import { Cloud, Folder } from "lucide-react";
import type { WorkspaceTabState } from "@/store/tabStore.js";

/** 拖拽预览只读当前 tab；不提交顺序、不改变 tab/Git 状态。 */
export function WorkspaceDragOverlay({
  tab,
  width,
}: {
  tab: WorkspaceTabState;
  width: number | null;
}) {
  const isRemote = Boolean(tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity);
  return (
    <div
      data-testid="workspace-drag-overlay"
      className="pointer-events-none flex cursor-grabbing items-center rounded-lg border border-border bg-background text-ui-base text-foreground shadow-lg h-8 px-2.5 gap-2 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0"
      style={width ? { width } : undefined}
    >
      {/* 项目列表图标位于 Button 内，运行态会被按钮 SVG 规则收敛为 14px；
          overlay 脱离 Button 后不再继承该规则，因此显式使用相同尺寸，避免 preview 图标放大。 */}
      {isRemote ? (
        <Cloud className="size-3.5 shrink-0 text-foreground-subtle" />
      ) : (
        <Folder className="size-3.5 shrink-0 text-foreground-subtle" />
      )}
      <span className="min-w-0 flex-1 truncate px-1">{tab.label}</span>
    </div>
  );
}
