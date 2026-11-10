import { BrowserWindow } from "electron";
import { MessagePortProtocol } from "@zcode/rpc";
import type { ElectronUtilityProcessLike } from "electron";
import { wrapElectronPort } from "../../host/electronPort.js";
import { attachWorkspaceHostPort } from "./hostBridge.js";
import {
  createWebClientEndpoint,
  type WebClientEndpoint,
  type WebClientRpcAttachment,
} from "./webClientEndpoint.js";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * 浏览器远控 attachment：复用窗口 Host 既有的 AttachServicePort 通道（local scope）。
 *
 * 不新建 Host、不新起 Agent、不复制业务状态：浏览器与桌面 renderer 看到的是同一个 owner。
 * 远端 workspace scope 由 B4 片单独接入，这里刻意只做 local，避免把「按路径猜 identity」带进来。
 */
export function openWebClientAttachment(params: {
  windowId: number;
  workspacePath: string;
  resolveHostProcess(webContentsId: number): ElectronUtilityProcessLike | undefined;
  logger: WebRemoteControlLogger;
}): WebClientRpcAttachment {
  const window = BrowserWindow.fromId(params.windowId);
  if (!window || window.isDestroyed()) {
    throw new Error("web client remote: window is unavailable");
  }
  const attachment = attachWorkspaceHostPort({
    windowId: params.windowId,
    webContentsId: window.webContents.id,
    workspacePath: params.workspacePath,
    // 浏览器跑完整 Web 客户端，授权面比手机子集宽（仍拒绝窗口/设备/凭据写面）。
    surface: "web-client",
    resolveHostProcess: params.resolveHostProcess,
    logger: params.logger,
  });
  const protocol = new MessagePortProtocol(wrapElectronPort(attachment.port));
  return {
    onMessage: (listener) => protocol.onMessage(listener),
    send: (buffer) => protocol.send(buffer),
    dispose() {
      // Bug 原因：MessagePortProtocol 只有 disconnect()，没有 dispose()。
      // 直接调 dispose 会在 WS 关闭时抛 TypeError，把整个 main 进程带崩（原生错误弹窗）。
      protocol.disconnect();
      attachment.dispose();
    },
  };
}

/**
 * 启动浏览器远控端点：QR 指向它，配对成功即换 Cookie，随后 `/ws` 复用上面的 attachment。
 * 失败一律抛出，由调用方停止整个远控运行时——不允许「一半可用」。
 */
export async function startWindowWebClientEndpoint(params: {
  windowId: number;
  deviceSid: string;
  passHash: string;
  workspacePath: string;
  appVersion: string;
  serverId: string;
  staticRoot: string | null;
  resolveHostProcess(webContentsId: number): ElectronUtilityProcessLike | undefined;
  logger: WebRemoteControlLogger;
}): Promise<{ endpoint: WebClientEndpoint; baseUrl?: string }> {
  const endpoint = createWebClientEndpoint({
    logger: params.logger,
    appVersion: params.appVersion,
    serverId: params.serverId,
    staticRoot: params.staticRoot,
    authorizePairing: ({ deviceSid, passHash }) =>
      deviceSid === params.deviceSid && passHash === params.passHash,
    openAttachment: () =>
      openWebClientAttachment({
        windowId: params.windowId,
        workspacePath: params.workspacePath,
        resolveHostProcess: params.resolveHostProcess,
        logger: params.logger,
      }),
  });
  const info = await endpoint.start();
  return {
    endpoint,
    baseUrl: info.baseUrls.find((url) => !url.includes("127.0.0.1")) ?? info.baseUrls[0],
  };
}

export interface WebClientRuntimeLike {
  windowId: number;
  deviceSid: string;
  passHash: string;
  workspacePath: string;
  qrBaseUrl: string;
  webClientEndpoint?: WebClientEndpoint;
}

/** 启动端点并把 QR base 换成浏览器入口；字段写回由调用方的 runtime owner 完成。 */
export async function attachRuntimeWebClient(
  runtime: WebClientRuntimeLike,
  deps: {
    appVersion: string;
    deviceMid: string;
    resolveHostProcess(webContentsId: number): ElectronUtilityProcessLike | undefined;
    logger: WebRemoteControlLogger;
  },
  staticRoot: string | null,
): Promise<void> {
  const started = await startWindowWebClientEndpoint({
    windowId: runtime.windowId,
    deviceSid: runtime.deviceSid,
    passHash: runtime.passHash,
    workspacePath: runtime.workspacePath,
    appVersion: deps.appVersion,
    serverId: deps.deviceMid,
    staticRoot,
    resolveHostProcess: deps.resolveHostProcess,
    logger: deps.logger,
  });
  runtime.webClientEndpoint = started.endpoint;
  if (started.baseUrl) runtime.qrBaseUrl = started.baseUrl;
}
