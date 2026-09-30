import type {
  WebRemoteControlAppPayload,
  WebRemoteControlFailureReason,
  WebRemoteControlPlatformMethod,
} from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";
import type { WebRemoteControlRelayAuthStorageProvider } from "./authStorage.js";
import type { WebRemoteControlRuntime } from "./runtime.js";

/**
 * 移动端 → 桌面的应用信封路由。桌面是唯一业务所有者：清单、视图态、bridge 调度
 * 都在这里落定；传输层（LAN 端点 / relay）只负责把信封搬过来。
 */

export interface PayloadRouterDeps {
  logger: WebRemoteControlLogger;
  handlePlatformRequest(method: WebRemoteControlPlatformMethod, args: unknown): Promise<unknown>;
  reconnectWorkspace(windowId: number, workspaceKey: string): Promise<void>;
}

export interface PayloadRouterContext {
  runtime: WebRemoteControlRuntime;
  deps: PayloadRouterDeps;
  authStorage: WebRemoteControlRelayAuthStorageProvider;
  sendAppPayload(runtime: WebRemoteControlRuntime, payload: WebRemoteControlAppPayload): void;
  openBridge(
    runtime: WebRemoteControlRuntime,
    request: {
      requestId: string;
      bridgeSessionId: string;
      workspaceKey: string;
      taskId?: string;
      bridgeGeneration?: number;
      recoveryId?: string;
    },
  ): { ok: true; bridge: unknown } | { ok: false; reason: string; error: string };
  emitStatus(runtime: WebRemoteControlRuntime): void;
}

export async function routeMobilePayload(
  payload: WebRemoteControlAppPayload,
  ctx: PayloadRouterContext,
): Promise<void> {
  const { runtime } = ctx;
  switch (payload.zcode_type) {
    case "bootstrap-request": {
      ctx.sendAppPayload(runtime, {
        zcode_type: "bootstrap-response",
        requestId: payload.requestId,
        success: true,
        result: buildBootstrapResult(runtime),
      });
      return;
    }
    case "workspace-list-request": {
      ctx.sendAppPayload(runtime, {
        zcode_type: "workspace-list-response",
        requestId: payload.requestId,
        success: true,
        result: buildWorkspaceListResult(runtime),
      });
      return;
    }
    case "platform-request": {
      try {
        const result = await ctx.deps.handlePlatformRequest(payload.method, payload.args);
        ctx.sendAppPayload(runtime, {
          zcode_type: "platform-response",
          requestId: payload.requestId,
          method: payload.method,
          success: true,
          result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.deps.logger.warn("[web-remote-control] platform request failed", {
          windowId: runtime.windowId,
          method: payload.method,
          error: message,
        });
        ctx.sendAppPayload(runtime, {
          zcode_type: "platform-response",
          requestId: payload.requestId,
          method: payload.method,
          success: false,
          error: message,
        });
      }
      return;
    }
    case "mobile-view-state-update": {
      runtime.mobileViewState = payload.viewState;
      runtime.mobileDeviceInfo = payload.deviceInfo;
      return;
    }
    case "workspace-bridge-open": {
      const result = ctx.openBridge(runtime, {
        requestId: payload.requestId,
        bridgeSessionId: payload.bridgeSessionId,
        workspaceKey: payload.workspaceKey,
        taskId: payload.taskId,
        bridgeGeneration: payload.bridgeGeneration,
        recoveryId: payload.recoveryId,
      });
      if (result.ok) {
        const bridge = runtime.bridge;
        if (bridge) {
          bridge.readyAnnounced = true;
        }
        ctx.sendAppPayload(runtime, {
          zcode_type: "workspace-bridge-ready",
          requestId: payload.requestId,
          bridgeSessionId: payload.bridgeSessionId,
          bridgeGeneration: payload.bridgeGeneration,
          recoveryId: payload.recoveryId,
          bridge: result.bridge as never,
        });
        return;
      }
      ctx.sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-error",
        requestId: payload.requestId,
        bridgeSessionId: payload.bridgeSessionId,
        bridgeGeneration: payload.bridgeGeneration,
        recoveryId: payload.recoveryId,
        reason: result.reason as WebRemoteControlFailureReason,
        error: result.error,
      });
      return;
    }
    case "workspace-reconnect-request": {
      try {
        await ctx.deps.reconnectWorkspace(runtime.windowId, payload.workspaceKey);
        ctx.sendAppPayload(runtime, {
          zcode_type: "workspace-reconnect-response",
          requestId: payload.requestId,
          workspaceKey: payload.workspaceKey,
          success: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.sendAppPayload(runtime, {
          zcode_type: "workspace-reconnect-response",
          requestId: payload.requestId,
          workspaceKey: payload.workspaceKey,
          success: false,
          error: message,
        });
      }
      return;
    }
    case "rpc-frame":
    case "rpc-frame-ack": {
      runtime.bridge?.acceptFrame(payload.frame);
      return;
    }
    case "telemetry-report": {
      // 零上报：本仓库不收集也不转发移动端遥测；仅本地 debug 日志。
      ctx.deps.logger.debug?.("[web-remote-control] telemetry report dropped");
      return;
    }
    case "mobile-diagnostic": {
      ctx.deps.logger.info("[web-remote-control] mobile diagnostic", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        event: payload.event,
        state: payload.state,
        pairStatus: payload.pairStatus,
        closeCode: payload.closeCode,
        failureReason: payload.failureReason,
      });
      return;
    }
    default:
      return;
  }
}

function activeWorkspaceKey(runtime: WebRemoteControlRuntime): string {
  return (
    runtime.mobileViewState?.activeWorkspaceKey ??
    (runtime.workspaceIdentity?.trim() || runtime.workspacePath)
  );
}

function buildBootstrapResult(runtime: WebRemoteControlRuntime) {
  return {
    windowControlSessionId: runtime.deviceSid,
    desktopAppVersion: runtime.desktopAppVersion,
    workspaces: runtime.workspaces,
    tasks: runtime.tasks,
    initialViewState: runtime.initialTaskId
      ? { activeWorkspaceKey: activeWorkspaceKey(runtime), activeTaskId: runtime.initialTaskId }
      : { activeWorkspaceKey: activeWorkspaceKey(runtime) },
    mobileViewState: runtime.mobileViewState,
  };
}

function buildWorkspaceListResult(runtime: WebRemoteControlRuntime) {
  return {
    workspaces: runtime.workspaces,
    tasks: runtime.tasks,
    activeWorkspaceKey: activeWorkspaceKey(runtime),
    activeTaskId: runtime.mobileViewState?.activeTaskId ?? runtime.initialTaskId,
  };
}
