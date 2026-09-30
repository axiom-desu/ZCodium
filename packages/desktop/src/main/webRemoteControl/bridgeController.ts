import { BrowserWindow } from "electron";
import type {
  WebRemoteControlBridgeDescriptor,
  WebRemoteControlFailureReason,
} from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";
import type { WebRemoteControlRuntime } from "./runtime.js";
import type { WebRemoteControlManagerDeps } from "./manager.js";
import { attachWorkspaceHostPort, openWebRemoteControlHostBridge } from "./hostBridge.js";

/**
 * workspace-bridge-open 处理：校验目标工作区属于当前桌面窗口 → 挂本地 Host port →
 * 建 RPC 装配器。返回 ready/error 信封载荷，由 payloadRouter 发送。
 */

export interface BridgeOpenRequest {
  requestId: string;
  bridgeSessionId: string;
  workspaceKey: string;
  taskId?: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

export type BridgeOpenResult =
  | { ok: true; bridge: WebRemoteControlBridgeDescriptor }
  | { ok: false; reason: WebRemoteControlFailureReason; error: string };

export function openWorkspaceBridge(
  runtime: WebRemoteControlRuntime,
  request: BridgeOpenRequest,
  deps: WebRemoteControlManagerDeps,
  sendAppPayload: (runtime: WebRemoteControlRuntime, payload: never) => void,
): BridgeOpenResult {
  // spec：只访问桌面当前窗口已经打开的工作区。
  const target = runtime.workspaces.find((item) => item.workspaceKey === request.workspaceKey);
  const fail = (reason: WebRemoteControlFailureReason, error: string): BridgeOpenResult => {
    deps.logger.warn("[web-remote-control] workspace bridge rejected", {
      windowId: runtime.windowId,
      workspaceKey: request.workspaceKey,
      reason,
    });
    return { ok: false, reason, error };
  };
  if (!target) {
    return fail(
      "unsupportedAction",
      "目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge。",
    );
  }
  if (target.kind === "remote" && target.connectionState !== "connected") {
    return fail("invalidMobileConnection", "目标远程工作区尚未连接，请先在桌面端重连。");
  }
  const webContentsId = BrowserWindow.fromId(runtime.windowId)?.webContents.id;
  if (webContentsId === undefined) {
    return fail("workspaceClosed", "桌面窗口已关闭。");
  }
  runtime.bridge?.dispose();
  runtime.bridge = undefined;
  let attachment;
  let opened;
  try {
    attachment = attachWorkspaceHostPort({
      windowId: runtime.windowId,
      webContentsId,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      resolveHostProcess: deps.resolveHostProcess,
      logger: deps.logger,
    });
    opened = openWebRemoteControlHostBridge({
      attachment,
      emitFrame: (envelope) => {
        sendAppPayload(runtime, envelope as never);
        return runtime.mobileConnected;
      },
      onDegraded: (reason) => {
        const bridge = runtime.bridge;
        if (!bridge || bridge.degraded) return;
        bridge.degraded = true;
        deps.logger.warn("[web-remote-control] raw relay bridge degraded", {
          windowId: runtime.windowId,
          bridgeSessionId: bridge.bridgeSessionId,
          reason,
        });
        sendAppPayload(runtime, {
          zcode_type: "bridge-degraded",
          bridgeSessionId: bridge.bridgeSessionId,
          bridgeGeneration: request.bridgeGeneration,
          recoveryId: request.recoveryId,
          reason: "rpc-transport-fault",
        } as never);
      },
      logger: deps.logger,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("unexpectedError", message);
  }
  runtime.bridge = {
    bridgeSessionId: request.bridgeSessionId,
    workspaceKey: request.workspaceKey,
    attachmentId: attachment.attachmentId,
    acceptFrame: (frame) => opened.bridge.acceptFrame(frame),
    emitAck: (seq) => opened.bridge.emitAck(seq),
    dispose: opened.dispose,
    readyAnnounced: false,
    degraded: false,
  };
  return {
    ok: true,
    bridge: {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      workspaceKey: request.workspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      kind: target.kind,
      entryKind: request.taskId ? "task" : "home",
    },
  };
}

export type { WebRemoteControlLogger };
