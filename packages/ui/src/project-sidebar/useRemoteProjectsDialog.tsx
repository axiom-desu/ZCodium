import { useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { RemoteProjectsDialog } from "./RemoteProjectsDialog.js";

/**
 * 远端项目入口的打开状态是唯一 UI 局部事实；列表与命令仍由 RemoteProjectService 提供。
 * 旧 Host/远端/手机没有该服务时 canManage=false，菜单项不渲染。
 */
export function useRemoteProjectsDialog() {
  const services = useOptionalServices();
  const [open, setOpen] = useState(false);
  const canManage = Boolean(services?.remoteProjectService);
  return {
    canManage,
    open: () => setOpen(true),
    element: canManage ? <RemoteProjectsDialog open={open} onClose={() => setOpen(false)} /> : null,
  };
}
