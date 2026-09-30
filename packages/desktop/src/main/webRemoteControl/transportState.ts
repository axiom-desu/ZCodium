import type { WebRemoteControlStatusSnapshot } from "@zcode/shared";
import type { WebRemoteControlRuntime } from "./runtime.js";
import { buildStatusSnapshot } from "./runtime.js";

/**
 * 传输态 → 用户态映射与手机断链宽限。
 * waiting_terminal = 等待手机（running）；paired = 已配对（active）；
 * 传输错误保持 relayUnavailable（bridge 期错误由 payloadRouter 单独映射）。
 */

const MOBILE_DISCONNECT_GRACE_MS = 30_000;

export function clearGraceTimer(runtime: WebRemoteControlRuntime): void {
  if (runtime.graceTimer) {
    clearTimeout(runtime.graceTimer);
    runtime.graceTimer = undefined;
  }
}

function scheduleMobileDisconnectGrace(
  runtime: WebRemoteControlRuntime,
  emitStatus: (runtime: WebRemoteControlRuntime) => void,
): void {
  if (runtime.graceTimer || runtime.status === "error") return;
  runtime.graceTimer = setTimeout(() => {
    runtime.graceTimer = undefined;
    runtime.mobileConnected = false;
    if (runtime.status !== "error") {
      runtime.status = "running";
    }
    emitStatus(runtime);
  }, MOBILE_DISCONNECT_GRACE_MS);
  runtime.graceTimer.unref?.();
}

export function mapTransportState(
  runtime: WebRemoteControlRuntime,
  state: string,
  emitStatus: (runtime: WebRemoteControlRuntime) => void,
  onPaired: (runtime: WebRemoteControlRuntime) => void,
): void {
  switch (state) {
    case "connecting":
    case "registering":
    case "authenticating": {
      runtime.status = runtime.mobileConnected ? "active" : "starting";
      emitStatus(runtime);
      return;
    }
    case "waiting_terminal": {
      if (runtime.mobileConnected) {
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime, emitStatus);
      } else {
        runtime.status = "running";
      }
      emitStatus(runtime);
      return;
    }
    case "paired": {
      clearGraceTimer(runtime);
      runtime.mobileConnected = true;
      runtime.hasEverPaired = true;
      runtime.status = "active";
      onPaired(runtime);
      emitStatus(runtime);
      return;
    }
    case "error": {
      runtime.status = "error";
      runtime.failure = { reason: "relayUnavailable", message: runtime.error };
      emitStatus(runtime);
      return;
    }
    default:
      return;
  }
}

export function idleStatus(): WebRemoteControlStatusSnapshot {
  return { status: "idle" };
}

export { buildStatusSnapshot };
