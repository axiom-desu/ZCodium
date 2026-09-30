import { ipcMain, type BrowserWindow, type WebContents } from "electron";
import {
  PlatformChannels,
  webRemoteControlResetPairingRequestSchema,
  webRemoteControlStartRequestSchema,
  webRemoteControlTaskSyncSchema,
  webRemoteControlWorkspaceSyncSchema,
} from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";
import type { WebRemoteControlManager } from "./manager.js";

/**
 * 远控 IPC 面（preload ↔ main）。开启/刷新走 authorizeStart + *Authorized 两步：
 * renderer 先取一次性令牌再由 main 消费，避免跨窗口误触开启他人工作区。
 */

const RECONNECT_TIMEOUT_MS = 120_000;

interface PendingReconnect {
  resolve(result: { requestId: string; success: boolean; error?: string }): void;
  timer: NodeJS.Timeout;
}

export interface RegisterWebRemoteControlIpcOptions {
  /** 延迟绑定：main 先注册 IPC 句柄，manager 组装完成后再回填。 */
  getManager(): WebRemoteControlManager;
  logger: WebRemoteControlLogger;
  resolveWindowId(sender: WebContents): number | undefined;
  resolveWindow(windowId: number): BrowserWindow | undefined;
}

export function registerWebRemoteControlIpcHandlers(options: RegisterWebRemoteControlIpcOptions) {
  const { logger } = options;
  const manager = () => options.getManager();
  const pendingReconnects = new Map<string, PendingReconnect>();

  ipcMain.handle(PlatformChannels.StartWebRemoteControl, async (event, payload: unknown) => {
    const windowId = options.resolveWindowId(event.sender);
    if (windowId === undefined) {
      throw new Error("未找到当前窗口，无法开启 Web 远程控制");
    }
    const target = webRemoteControlStartRequestSchema.parse(payload);
    const authorization = manager().authorizeStart(windowId, target);
    return manager().startAuthorized(windowId, target, authorization);
  });

  ipcMain.handle(PlatformChannels.StopWebRemoteControl, async (event) => {
    const windowId = options.resolveWindowId(event.sender);
    if (windowId === undefined) return;
    await manager().stop(windowId);
  });

  ipcMain.handle(PlatformChannels.GetWebRemoteControlStatus, (event) => {
    const windowId = options.resolveWindowId(event.sender);
    return windowId === undefined ? { status: "idle" as const } : manager().getStatus(windowId);
  });

  ipcMain.handle(PlatformChannels.ResetWebRemoteControlPairing, async (event, payload: unknown) => {
    const windowId = options.resolveWindowId(event.sender);
    if (windowId === undefined) {
      throw new Error("未找到当前窗口，无法刷新 Web 远程控制配对");
    }
    const target = webRemoteControlResetPairingRequestSchema.parse(payload);
    const authorization = manager().authorizeStart(windowId, target);
    return manager().resetPairingAuthorized(windowId, target, authorization);
  });

  ipcMain.handle(PlatformChannels.SyncWebRemoteControlWorkspaces, (event, payload: unknown) => {
    const windowId = options.resolveWindowId(event.sender);
    if (windowId === undefined) return;
    const parsed = webRemoteControlWorkspaceSyncSchema.parse(payload);
    manager().syncWorkspaces(windowId, parsed.workspaces);
  });

  ipcMain.handle(PlatformChannels.SyncWebRemoteControlTasks, (event, payload: unknown) => {
    const windowId = options.resolveWindowId(event.sender);
    if (windowId === undefined) return;
    const parsed = webRemoteControlTaskSyncSchema.parse(payload);
    manager().syncTasks(windowId, parsed.tasks);
  });

  // main → renderer 的重连请求；renderer 完成重连后经 invoke 回填结果。
  ipcMain.handle(
    PlatformChannels.WebRemoteControlReconnectWorkspace,
    (event, response: { requestId: string; success: boolean; error?: string }) => {
      void event;
      const pending = pendingReconnects.get(response.requestId);
      if (!pending) return;
      pendingReconnects.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    },
  );

  return {
    /** 供 manager 的 reconnectWorkspace 依赖调用：推送请求并等待 renderer 回填。 */
    async requestRendererReconnect(windowId: number, workspaceKey: string): Promise<void> {
      const win = options.resolveWindow(windowId);
      if (!win || win.webContents.isDestroyed()) {
        throw new Error("桌面窗口已关闭，无法重连工作区");
      }
      const requestId = `web-remote-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await new Promise<{
        requestId: string;
        success: boolean;
        error?: string;
      }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingReconnects.delete(requestId);
          reject(new Error("Web remote control reconnect request timed out."));
        }, RECONNECT_TIMEOUT_MS);
        pendingReconnects.set(requestId, { resolve, timer });
        win.webContents.send(PlatformChannels.WebRemoteControlReconnectWorkspace, {
          requestId,
          workspaceKey,
        });
      });
      if (!response.success) {
        throw new Error(response.error ?? "工作区重连失败");
      }
      logger.info("[web-remote-control] renderer reconnect done", {
        windowId,
        workspaceKey,
      });
    },
    dispose() {
      for (const pending of pendingReconnects.values()) {
        clearTimeout(pending.timer);
      }
      pendingReconnects.clear();
    },
  };
}

export type WebRemoteControlIpcHandle = ReturnType<typeof registerWebRemoteControlIpcHandlers>;
