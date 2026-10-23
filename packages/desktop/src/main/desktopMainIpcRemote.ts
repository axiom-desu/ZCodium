/* eslint-disable max-lines -- 远程连接、工作区链接和通知 IPC 共用窗口级上下文，集中注册避免跨文件状态漂移。 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  formatZodError,
  normalizeUnknownError,
  InternalChannels,
  PlatformChannels,
  remoteTargetSchema,
  type RemoteTarget,
} from "@zcode/shared";
import { dispatchTaskNotification } from "./desktopNotifications.js";
import { getBuiltinProviderConfigFileInfo } from "./desktopProviderConfig.js";
import {
  clearWorkspaceDeepLinkStateForWindow,
  deliverPendingWorkspaceOpen,
} from "./desktopOAuthDeepLink.js";
import { openPathInDefaultApp } from "./desktopMainIpcHelpers.js";

function isAllowedExternalOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

interface OpenExternalRequest {
  url: string;
}

function parseOpenExternalRequest(payload: unknown): OpenExternalRequest | null {
  if (typeof payload === "string") {
    return { url: payload };
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    url: record.url,
  };
}

export function registerRemoteIpcHandlers(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  createRemoteWorkspaceSession: (
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: { workspacePath: string; workspaceIdentity?: string },
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (
    sessionId: string,
    reason: string,
    signalGracePeriodMs?: number,
  ) => void;
  cancelPendingRemoteWorkspaceSessionsForWindow: (
    wcId: number,
    reason: string,
    requestId?: string,
  ) => void;
  bindRemoteWorkspaceSessionContext: (
    sessionId: string,
    context: { workspacePath: string; workspaceIdentity?: string },
    expectedWebContentsId?: number,
  ) => Promise<void>;
  confirmRendererAttachmentReady: (
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ) => void;
  isDockerDaemonAvailable: () => Promise<boolean>;
  listAvailableWSLDistros: () => Promise<unknown[]>;
  listAvailableDockerContainers: () => Promise<unknown[]>;
  listSSHConfigAliases: () => Promise<unknown[]>;
}) {
  ipcMain.on(InternalChannels.ScopedServicePortReady, (event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as { sessionId?: unknown; attachmentId?: unknown };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const attachmentId =
      typeof payload.attachmentId === "string" ? payload.attachmentId.trim() : "";
    if (!sessionId || !attachmentId) return;
    options.confirmRendererAttachmentReady(event.sender.id, { sessionId, attachmentId });
  });

  ipcMain.on(PlatformChannels.OpenExternal, (event, payload: unknown) => {
    const request = parseOpenExternalRequest(payload);
    if (!request) {
      options.logger.warn("[open-external] blocked unsupported request", payload);
      return;
    }
    const { url } = request;
    if (!isAllowedExternalOpenUrl(url)) {
      options.logger.warn("[open-external] blocked unsupported url", url);
      return;
    }
    void Promise.resolve(shell.openExternal(url)).catch((error: unknown) => {
      options.logger.warn("[open-external] 外部 URL 打开失败", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    openPathInDefaultApp(rawPath, options.logger),
  );

  ipcMain.handle(PlatformChannels.GetBuiltinProviderConfigFile, async () =>
    getBuiltinProviderConfigFileInfo(),
  );

  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    deliverPendingWorkspaceOpen(event.sender);
  });

  ipcMain.on(PlatformChannels.ShowTaskNotification, (event, payload: unknown) => {
    dispatchTaskNotification({ event, payload, logger: options.logger });
  });
  ipcMain.handle(PlatformChannels.ShowTaskNotification, (event, payload: unknown) =>
    dispatchTaskNotification({ event, payload, logger: options.logger }),
  );

  app.on("browser-window-created", (_, win) => {
    const windowWebContentsId = win.webContents.id;
    win.on("closed", () => {
      // BrowserWindow 的 closed 阶段里 webContents 可能已被 Electron 释放。
      // 之前这里直接读取 win.webContents.id，会把正常关窗流程变成主进程未捕获异常。
      // 提前缓存 id 后再做清理，避免访问已经销毁的对象。
      clearWorkspaceDeepLinkStateForWindow(windowWebContentsId);
    });
  });

  ipcMain.handle(PlatformChannels.ConnectRemote, async (event, rawPayload: unknown) => {
    const wrappedPayload: {
      target: unknown;
      requestId?: unknown;
      workspacePath?: unknown;
      workspaceIdentity?: unknown;
      connectTrigger?: unknown;
    } =
      rawPayload && typeof rawPayload === "object" && "target" in rawPayload
        ? (rawPayload as {
            target: unknown;
            requestId?: unknown;
            workspacePath?: unknown;
            workspaceIdentity?: unknown;
            connectTrigger?: unknown;
          })
        : { target: rawPayload, requestId: undefined };
    const result = remoteTargetSchema.safeParse(wrappedPayload.target);
    if (!result.success) {
      const error = `Invalid connect-remote payload: ${formatZodError(result.error)}`;
      options.logger.warn("[connect-remote]", error);
      return { success: false, error };
    }
    const requestId =
      typeof wrappedPayload.requestId === "string" && wrappedPayload.requestId.trim().length > 0
        ? wrappedPayload.requestId.trim()
        : undefined;
    const workspacePath =
      typeof wrappedPayload.workspacePath === "string" &&
      wrappedPayload.workspacePath.trim().length > 0
        ? wrappedPayload.workspacePath
        : undefined;
    const workspaceIdentity =
      typeof wrappedPayload.workspaceIdentity === "string" &&
      wrappedPayload.workspaceIdentity.trim().length > 0
        ? wrappedPayload.workspaceIdentity
        : undefined;

    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw new Error("未找到当前窗口，无法创建远程 session");
      }

      const sessionId = await options.createRemoteWorkspaceSession(
        win,
        result.data,
        requestId,
        workspacePath ? { workspacePath, workspaceIdentity } : undefined,
      );
      return { success: true, sessionId };
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // 这里之前直接把 Error 对象交给 logger，落盘时会被 JSON.stringify 压成 `{}`。
      // 改成显式展开 message/code/stack，保证远程建连失败时主进程日志里能看到真实上下文。
      options.logger.error("[connect-remote] caught error:", {
        message: normalizedError.message,
        code: normalizedError.code,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: normalizedError.message };
    }
  });

  ipcMain.handle(
    PlatformChannels.CancelPendingRemoteConnection,
    async (event, rawPayload: unknown) => {
      const payload =
        rawPayload && typeof rawPayload === "object" ? (rawPayload as { requestId?: unknown }) : {};
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.trim().length > 0
          ? payload.requestId.trim()
          : undefined;
      // 连接建立前没有 sessionId，renderer 之前无法精准通知 main 取消正在进行的连接。
      // 现在优先按 requestId 精确取消当前弹窗发起的连接，避免误伤同窗口其他并发连接。
      // 若 requestId 缺失则回退到按窗口取消，兼容旧调用端。
      options.cancelPendingRemoteWorkspaceSessionsForWindow(
        event.sender.id,
        `cancel-pending-remote-connection:${event.sender.id}`,
        requestId,
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BindRemoteWorkspaceSessionContext,
    async (event, rawPayload: unknown) => {
      if (!rawPayload || typeof rawPayload !== "object") {
        throw new Error("远程 workspace context payload 无效");
      }
      const payload = rawPayload as {
        remoteSessionId?: unknown;
        workspacePath?: unknown;
        workspaceIdentity?: unknown;
      };
      const remoteSessionId =
        typeof payload.remoteSessionId === "string" ? payload.remoteSessionId.trim() : "";
      const workspacePath = typeof payload.workspacePath === "string" ? payload.workspacePath : "";
      const workspaceIdentity =
        typeof payload.workspaceIdentity === "string" ? payload.workspaceIdentity.trim() : "";
      if (!remoteSessionId || !workspacePath.trim()) {
        throw new Error("远程 workspace context 缺少 sessionId 或 workspacePath");
      }
      await options.bindRemoteWorkspaceSessionContext(
        remoteSessionId,
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        },
        event.sender.id,
      );
    },
  );

  ipcMain.handle(PlatformChannels.DisposeRemoteSession, async (_event, sessionId: string) => {
    options.disposeRemoteWorkspaceSession(sessionId, `dispose-remote-session:${sessionId}`, 150);
  });

  ipcMain.handle(PlatformChannels.IsDockerAvailable, async () => {
    try {
      return await options.isDockerDaemonAvailable();
    } catch (error) {
      options.logger.warn("[is-docker-available] detect failed:", error);
      return false;
    }
  });

  ipcMain.handle(PlatformChannels.ListWSLDistros, async () => {
    try {
      return await options.listAvailableWSLDistros();
    } catch (error) {
      options.logger.warn("[list-wsl-distros] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListDockerContainers, async () => {
    try {
      return await options.listAvailableDockerContainers();
    } catch (error) {
      options.logger.warn("[list-docker-containers] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListSSHConfigAliases, async () => {
    try {
      return await options.listSSHConfigAliases();
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // Error 对象直接落盘会被序列化成 `{}`，SSH config 解析失败时无法定位具体 pattern。
      // 显式展开错误字段，保留 UI 返回空列表的兼容行为，同时让日志能看到根因。
      options.logger.warn("[list-ssh-config-aliases] detect failed:", {
        message: normalizedError.message,
        code: normalizedError.code,
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return [];
    }
  });
}
