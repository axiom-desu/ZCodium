import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";

/**
 * 手机 Web 的任务侧栏抽屉。
 *
 * 只负责“把既有 sidebar 内容放进一个从左侧滑出的模态层”：
 * - Radix Dialog 提供焦点约束、Escape、遮罩点击关闭与可访问名称；
 * - 内容仍由 WorkspaceShellLayout 传入的同一个 WorkspaceSidebar 实例渲染，
 *   这里不复制任务列表、不新增 store；
 * - 开合仍由 useAppPanels 的 isSidebarVisible 决定，组件本身不持有业务状态。
 */
export function WorkspaceSidebarDrawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // 只处理关闭方向：打开由顶部菜单命令驱动，避免出现第二条开合写入口。
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        data-testid="workspace-sidebar-drawer"
        className={cn(
          // DialogContent 默认居中弹窗；手机抽屉改为贴左侧、满高、无圆角无边框。
          "top-0 left-0 h-[100dvh] max-h-[100dvh] w-[min(88vw,320px)] max-w-none translate-x-0 translate-y-0",
          "gap-0 rounded-none border-0 p-0 shadow-none",
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
