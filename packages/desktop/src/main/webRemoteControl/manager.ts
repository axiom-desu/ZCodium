import {
  webRemoteControlStartRequestSchema,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlFailureReason,
  type WebRemoteControlBridgeDescriptor,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlStatusSnapshot,
  type WebRemoteControlTaskRef,
  type WebRemoteControlWorkspaceRef,
} from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import type { WebRemoteControlLogger } from "./logger.js";
import { createNodeWebRemoteControlRelayAuthProvider } from "./authProvider.js";
import { createWebRemoteControlRelayAuthStorageProvider } from "./authStorage.js";
import { buildWebRemoteControlQrUrl } from "./qrUrl.js";
import { LanRemoteControlEndpoint } from "./lanEndpoint.js";
import { createLanDeviceTransport } from "./deviceTransport.js";
import { buildStatusSnapshot, type WebRemoteControlRuntime } from "./runtime.js";
import { routeMobilePayload } from "./payloadRouter.js";
import { clearPendingOutbound, flushPendingOutbound, sendAppPayload } from "./outboundBuffer.js";
import { clearGraceTimer, mapTransportState } from "./transportState.js";
import { createStartAuthorizationStore, type StartAuthorization } from "./authorization.js";
import { openWorkspaceBridge } from "./bridgeController.js";

/**
 * Web Remote Control 桌面运行时：按窗口一份，持有配对、传输与 Host bridge。
 *
 * 状态机（spec）：idle → starting → connecting → running ⇄ active → error；
 * 传输态 waiting_terminal = 等待手机，paired = 已配对。失败语义见 shared/status.ts。
 */

interface ElectronUtilityProcessLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
}

export interface WebRemoteControlTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlManagerDeps {
  logger: WebRemoteControlLogger;
  settingService: ISettingService;
  credentialService: ICredentialService;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  lanPort?: number;
  onStatusChanged(windowId: number, snapshot: WebRemoteControlStatusSnapshot): void;
  handlePlatformRequest(method: WebRemoteControlPlatformMethod, args: unknown): Promise<unknown>;
  /** 请 renderer 重连指定 workspace 的远端会话（workspace-reconnect-request）。 */
  reconnectWorkspace(windowId: number, workspaceKey: string): Promise<void>;
  resolveHostProcess(webContentsId: number): ElectronUtilityProcessLike | undefined;
}

export type WebRemoteControlOpenBridgeResult =
  | { ok: true; bridge: WebRemoteControlBridgeDescriptor }
  | { ok: false; reason: WebRemoteControlFailureReason; error: string };

export interface WebRemoteControlManager {
  authorizeStart(windowId: number, target: WebRemoteControlTarget): StartAuthorization;
  startAuthorized(
    windowId: number,
    target: WebRemoteControlTarget,
    authorization: StartAuthorization,
  ): Promise<WebRemoteControlStatusSnapshot>;
  start(windowId: number, target: WebRemoteControlTarget): Promise<WebRemoteControlStatusSnapshot>;
  stop(windowId: number): Promise<void>;
  resetPairing(
    windowId: number,
    target: WebRemoteControlTarget,
  ): Promise<WebRemoteControlStatusSnapshot>;
  resetPairingAuthorized(
    windowId: number,
    target: WebRemoteControlTarget,
    authorization: StartAuthorization,
  ): Promise<WebRemoteControlStatusSnapshot>;
  getStatus(windowId: number): WebRemoteControlStatusSnapshot;
  syncWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceRef[]): void;
  syncTasks(windowId: number, tasks: WebRemoteControlTaskRef[]): void;
  disposeWindow(windowId: number): Promise<void>;
}

export function createWebRemoteControlManager(
  deps: WebRemoteControlManagerDeps,
): WebRemoteControlManager {
  const runtimes = new Map<number, WebRemoteControlRuntime>();
  const runtimesByDeviceSid = new Map<string, WebRemoteControlRuntime>();
  const authorizationStore = createStartAuthorizationStore();
  const authProvider = createNodeWebRemoteControlRelayAuthProvider();
  const authStorage = createWebRemoteControlRelayAuthStorageProvider({
    settingService: deps.settingService,
    credentialService: deps.credentialService,
    logger: deps.logger,
  });
  const endpoint = new LanRemoteControlEndpoint({
    logger: deps.logger,
    deviceMid: deps.deviceMid,
    deviceName: deps.deviceName,
    appVersion: deps.appVersion,
    handleMobilePayload: (deviceSid, payload) => {
      const runtime = runtimesByDeviceSid.get(deviceSid);
      if (!runtime) return;
      void routeMobilePayload(payload, buildRouterContext(runtime));
    },
    maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
    port: deps.lanPort,
  });

  function workspaceKeyOf(target: { workspacePath: string; workspaceIdentity?: string }): string {
    return target.workspaceIdentity?.trim() || target.workspacePath;
  }

  function emitStatus(runtime: WebRemoteControlRuntime): void {
    deps.onStatusChanged(runtime.windowId, buildStatusSnapshot(runtime));
  }

  /** payloadRouter 上下文：统一出口，避免每个回调重复接线。 */
  function buildRouterContext(runtime: WebRemoteControlRuntime) {
    return {
      runtime,
      deps,
      authStorage,
      sendAppPayload: (target: WebRemoteControlRuntime, payload: WebRemoteControlAppPayload) =>
        sendAppPayload(target, payload, deps.logger),
      openBridge: (
        target: WebRemoteControlRuntime,
        request: Parameters<typeof openWorkspaceBridge>[1],
      ) =>
        openWorkspaceBridge(target, request, deps, (bridgeRuntime, envelope) =>
          sendAppPayload(bridgeRuntime, envelope, deps.logger),
        ),
      emitStatus,
    };
  }

  // ---- 生命周期 ----

  function disposeRuntime(runtime: WebRemoteControlRuntime, reason: string): void {
    clearGraceTimer(runtime);
    clearPendingOutbound(runtime);
    runtime.bridge?.dispose();
    runtime.bridge = undefined;
    runtime.transport.dispose();
    runtimes.delete(runtime.windowId);
    if (runtimesByDeviceSid.get(runtime.deviceSid) === runtime) {
      runtimesByDeviceSid.delete(runtime.deviceSid);
    }
    deps.logger.info("[web-remote-control] stopped", {
      windowId: runtime.windowId,
      session: runtime.deviceSid,
      reason,
    });
    deps.onStatusChanged(runtime.windowId, { status: "idle" });
  }

  async function stopRuntime(windowId: number, reason: string): Promise<void> {
    const runtime = runtimes.get(windowId);
    if (!runtime) return;
    disposeRuntime(runtime, reason);
  }

  async function start(windowId: number, target: WebRemoteControlTarget) {
    const parsed = webRemoteControlStartRequestSchema.parse(target);
    await stopRuntime(windowId, "restart");
    const persisted = await authStorage.load();
    const auth:
      | { mode: "register"; passHash: string }
      | { mode: "persisted"; deviceSid: string; passHash: string } = persisted
      ? { mode: "persisted", deviceSid: persisted.deviceSid, passHash: persisted.passHash }
      : {
          mode: "register",
          passHash: authProvider.createPassHash(authProvider.createPassword()),
        };

    const runtime: WebRemoteControlRuntime = {
      windowId,
      workspacePath: parsed.workspacePath,
      workspaceIdentity: parsed.workspaceIdentity,
      remoteSessionId: parsed.remoteSessionId,
      initialTaskId: parsed.initialTaskId,
      status: "starting",
      desktopAppVersion: deps.appVersion,
      deviceSid: auth.mode === "persisted" ? auth.deviceSid : "pending",
      passHash: auth.passHash,
      qrBaseUrl: "",
      qrUrl: "",
      transport: undefined as never,
      mobileConnected: false,
      hasEverPaired: false,
      mobileDeviceSeenAt: 0,
      pendingOutbound: [],
      workspaces: [],
      tasks: [],
    };
    const transport = createLanDeviceTransport({
      logger: deps.logger,
      deviceMid: deps.deviceMid,
      deviceName: deps.deviceName,
      appVersion: deps.appVersion,
      auth,
      endpoint,
      events: {
        onStateChange: (state) =>
          mapTransportState(runtime, state, emitStatus, (pairedRuntime) =>
            flushPendingOutbound(pairedRuntime, deps.logger),
          ),
        onPayload: (payload) => void routeMobilePayload(payload, buildRouterContext(runtime)),
        onRegisteredAuth: (registered) => {
          runtime.deviceSid = registered.deviceSid;
          runtimesByDeviceSid.set(registered.deviceSid, runtime);
          void authStorage.save(registered);
          deps.logger.info("[web-remote-control] device registered", {
            windowId,
            deviceSidSuffix: registered.deviceSid.slice(-6),
          });
        },
        onError: (error) => {
          deps.logger.warn("[web-remote-control] device transport error", {
            windowId,
            message: error.message,
          });
        },
        onInvalidPersistedAuth: async () => {
          await authStorage.clear();
        },
      },
      handleMobilePayload: (deviceSid, payload) => {
        const target2 = runtimesByDeviceSid.get(deviceSid);
        if (!target2) return;
        void routeMobilePayload(payload, buildRouterContext(target2));
      },
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
      port: deps.lanPort,
    });
    runtime.transport = transport;
    runtimes.set(windowId, runtime);
    emitStatus(runtime);
    try {
      await transport.start();
    } catch (error) {
      await stopRuntime(windowId, "transport-start-failed");
      throw error;
    }
    const baseUrls = transport.baseUrls();
    runtime.qrBaseUrl = baseUrls.find((url) => !url.includes("127.0.0.1")) ?? baseUrls[0] ?? "";
    if (runtime.deviceSid && runtime.deviceSid !== "pending") {
      runtime.qrUrl = buildQrUrl(runtime);
    }
    emitStatus(runtime);
    try {
      await deps.settingService.update({
        webRemoteControlLastEnabledContext: {
          workspacePath: parsed.workspacePath,
          workspaceIdentity: parsed.workspaceIdentity,
          initialTaskId: parsed.initialTaskId,
        },
      });
    } catch (error) {
      await stopRuntime(windowId, "startup-restore-persist-failed");
      throw error;
    }
    return buildStatusSnapshot(runtime);
  }

  function buildQrUrl(runtime: WebRemoteControlRuntime): string {
    return buildWebRemoteControlQrUrl({
      baseUrl: runtime.qrBaseUrl,
      deviceSid: runtime.deviceSid,
      passHash: runtime.passHash,
      timestamp: Date.now(),
      deviceMid: deps.deviceMid,
      deviceName: deps.deviceName,
      appVersion: deps.appVersion,
    });
  }

  async function resetPairing(windowId: number, target: WebRemoteControlTarget) {
    await authStorage.clear();
    return start(windowId, target);
  }

  return {
    authorizeStart(windowId, target) {
      return authorizationStore.issue(windowId, target, workspaceKeyOf(target));
    },
    startAuthorized(windowId, target, authorization) {
      authorizationStore.consume(windowId, target, authorization, workspaceKeyOf(target));
      return start(windowId, target);
    },
    start,
    async stop(windowId) {
      await stopRuntime(windowId, "manual-stop");
      await deps.settingService
        .update({ webRemoteControlLastEnabledContext: undefined })
        .catch(() => undefined);
    },
    resetPairing,
    resetPairingAuthorized(windowId, target, authorization) {
      authorizationStore.consume(windowId, target, authorization, workspaceKeyOf(target));
      return resetPairing(windowId, target);
    },
    getStatus(windowId) {
      const runtime = runtimes.get(windowId);
      return runtime ? buildStatusSnapshot(runtime) : { status: "idle" };
    },
    syncWorkspaces(windowId, workspaces) {
      const runtime = runtimes.get(windowId);
      if (runtime) runtime.workspaces = workspaces;
    },
    syncTasks(windowId, tasks) {
      const runtime = runtimes.get(windowId);
      if (runtime) runtime.tasks = tasks;
    },
    async disposeWindow(windowId) {
      await stopRuntime(windowId, "window-disposed");
    },
  };
}
