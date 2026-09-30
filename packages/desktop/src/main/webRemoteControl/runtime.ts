import type {
  WebRemoteControlAppPayload,
  WebRemoteControlFailure,
  WebRemoteControlMobileDeviceInfo,
  WebRemoteControlMobileViewState,
  WebRemoteControlStatusSnapshot,
  WebRemoteControlStatusState,
  WebRemoteControlTaskRef,
  WebRemoteControlWorkspaceRef,
} from "@zcode/shared";

/** 窗口级远控运行时（manager 与 payloadRouter 共享的形状）。 */
export interface WebRemoteControlRuntime {
  windowId: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  /** 移动端最近回传的视图态；桌面只存不解释。 */
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  status: WebRemoteControlStatusState;
  /** 桌面 app 版本，随 bootstrap-response 下发给移动端。 */
  desktopAppVersion: string;
  deviceSid: string;
  passHash: string;
  qrBaseUrl: string;
  /** 完整配对链接（baseUrl + sid/hash/t/...）；status 输出用。 */
  qrUrl: string;
  transport: import("./deviceTransport.js").WebRemoteControlDeviceTransport;
  mobileConnected: boolean;
  hasEverPaired: boolean;
  mobileDeviceSeenAt: number;
  failure?: WebRemoteControlFailure;
  error?: string;
  graceTimer?: NodeJS.Timeout;
  pendingOutbound: WebRemoteControlAppPayload[];
  pendingTimer?: NodeJS.Timeout;
  workspaces: WebRemoteControlWorkspaceRef[];
  tasks: WebRemoteControlTaskRef[];
  bridge?: WebRemoteControlBridgeState;
}

export interface WebRemoteControlBridgeState {
  bridgeSessionId: string;
  workspaceKey: string;
  attachmentId: string;
  acceptFrame(frame: {
    streamId: string;
    seq: number;
    kind: "message" | "ack" | "flow";
    message?: unknown;
  }): void;
  emitAck(seq: number): void;
  dispose(): void;
  readyAnnounced: boolean;
  degraded: boolean;
}

export function buildStatusSnapshot(
  runtime: WebRemoteControlRuntime,
): WebRemoteControlStatusSnapshot {
  return {
    status: runtime.status,
    sessionId: runtime.deviceSid,
    windowControlSessionId: runtime.deviceSid,
    mobileConnected: runtime.mobileConnected,
    qrUrl: statusQrUrl(runtime),
    connectUrl: statusQrUrl(runtime),
    workspacePath: runtime.workspacePath,
    workspaceIdentity: runtime.workspaceIdentity,
    remoteSessionId: runtime.remoteSessionId,
    initialTaskId: runtime.initialTaskId,
    error: runtime.error,
    failure: runtime.failure,
  };
}

/** 快照里的 qrUrl/connectUrl 只在运行态输出；idle/error 不带链接，避免 UI 渲染陈旧二维码。 */
function statusQrUrl(runtime: WebRemoteControlRuntime): string | undefined {
  if (runtime.status === "idle" || runtime.status === "error") {
    return undefined;
  }
  return runtime.qrUrl;
}
