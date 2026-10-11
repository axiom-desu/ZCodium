import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { app, BrowserWindow, type WebContents } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type { WebRemoteControlPlatformMethod } from "@zcode/shared";
import {
  isDockerDaemonAvailable,
  listAvailableDockerContainers,
  listAvailableWSLDistros,
  listSSHConfigAliases,
} from "../desktopRuntimeEnv.js";
import { createTempTextAttachment } from "../tempTextAttachment.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "../mcpUserDirectory/index.js";
import type { WebRemoteControlLogger } from "./logger.js";
import type { ICredentialService, ISettingService } from "@zcode/services";
import { createWebRemoteControlManager, type WebRemoteControlManager } from "./manager.js";
import { registerWebRemoteControlIpcHandlers, type WebRemoteControlIpcHandle } from "./ipc.js";

/**
 * 组装入口：main 进程只在这里注入平台能力（Docker/WSL/SSH/MCP/窗口/host 进程），
 * manager 与其依赖不直接 import 这些平台实现，保持可测试边界。
 */

export interface CreateWebRemoteControlOptions {
  logger: WebRemoteControlLogger;
  settingService: ISettingService;
  credentialService: ICredentialService;
  resolveHostProcess(webContentsId: number): ElectronUtilityProcessLike | undefined;
  /**
   * 远端 workspace 连接态的权威解析（桌面 remote session 路由表）。
   * 由拥有 `RemoteWorkspaceSessionManager` 实例的 main 组装处注入；
   * 未注入时 manager 不覆盖 UI 载荷里的 connectionState，bridge 侧会 fail-closed。
   */
  resolveRemoteWorkspaceConnectionState?: (remoteSessionId: string) => "connected" | "disconnected";
}

interface ElectronUtilityProcessLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
}

export interface WebRemoteControlRuntimeHandle {
  manager: WebRemoteControlManager;
  dispose(): void;
}

export async function createWebRemoteControl(
  options: CreateWebRemoteControlOptions,
): Promise<WebRemoteControlRuntimeHandle> {
  const { logger, settingService, credentialService } = options;
  const settings = await settingService.get();
  const deviceMid = settings.webRemoteControlDeviceMid ?? randomUUID();
  if (!settings.webRemoteControlDeviceMid) {
    await settingService.update({ webRemoteControlDeviceMid: deviceMid });
  }

  const resolveWindow = (windowId: number): BrowserWindow | undefined =>
    BrowserWindow.fromId(windowId) ?? undefined;
  const resolveWindowId = (sender: WebContents): number | undefined =>
    BrowserWindow.fromWebContents(sender)?.id;

  const managerHolder: { manager?: WebRemoteControlManager } = {};
  const ipcHandle: WebRemoteControlIpcHandle = registerWebRemoteControlIpcHandlers({
    getManager: () => {
      if (!managerHolder.manager) {
        throw new Error("Web remote control manager is not ready");
      }
      return managerHolder.manager;
    },
    logger,
    resolveWindowId,
    resolveWindow,
  });

  async function handlePlatformRequest(
    method: WebRemoteControlPlatformMethod,
    args: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "isDockerAvailable":
        return isDockerDaemonAvailable();
      case "listWSLDistros":
        return listAvailableWSLDistros();
      case "listDockerContainers":
        return listAvailableDockerContainers();
      case "listSSHConfigAliases":
        return listSSHConfigAliases();
      case "createTempTextAttachment":
        return createTempTextAttachment(args as Parameters<typeof createTempTextAttachment>[0]);
      case "loadMcpFromUserDirectory":
        return loadCliMcpFromUserDirectory(
          args as Parameters<typeof loadCliMcpFromUserDirectory>[0],
        );
      case "saveMcpToUserDirectory":
        return saveCliMcpToUserDirectory(args as Parameters<typeof saveCliMcpToUserDirectory>[0]);
      case "migrateLegacyCommonMcp":
        return migrateLegacyCommonMcp(args as Parameters<typeof migrateLegacyCommonMcp>[0]);
      default:
        throw new Error(`Unsupported web remote control platform method: ${String(method)}`);
    }
  }

  const manager = createWebRemoteControlManager({
    logger,
    settingService,
    credentialService,
    deviceMid,
    deviceName: hostname(),
    appVersion: app.getVersion(),
    lanPort: resolveLanPort(),
    onStatusChanged: (windowId, snapshot) => {
      const win = resolveWindow(windowId);
      if (!win || win.webContents.isDestroyed()) return;
      win.webContents.send(PlatformChannels.WebRemoteControlStatusChanged, snapshot);
    },
    handlePlatformRequest,
    reconnectWorkspace: (windowId, workspaceKey) =>
      ipcHandle.requestRendererReconnect(windowId, workspaceKey),
    resolveHostProcess: options.resolveHostProcess,
    resolveRemoteWorkspaceConnectionState: options.resolveRemoteWorkspaceConnectionState,
  });
  managerHolder.manager = manager;

  return {
    manager,
    dispose() {
      ipcHandle.dispose();
    },
  };
}

function resolveLanPort(): number | undefined {
  const raw = process.env.ZCODE_WEB_REMOTE_PORT?.trim();
  if (!raw) return undefined;
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}
