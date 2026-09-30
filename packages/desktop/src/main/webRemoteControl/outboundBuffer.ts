import type { WebRemoteControlAppPayload } from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";
import type { WebRemoteControlRuntime } from "./runtime.js";

/**
 * 出站缓冲：手机未就绪（未配对/传输不可用）时最多暂存 50 条应用信封，
 * 5s 未 flush 即丢弃并告警。配对成功（paired）时由 manager 触发 flush。
 */

const MAX_PENDING_OUTBOUND = 50;
const PENDING_OUTBOUND_TIMEOUT_MS = 5_000;

export function clearPendingOutbound(runtime: WebRemoteControlRuntime): void {
  if (runtime.pendingTimer) {
    clearTimeout(runtime.pendingTimer);
    runtime.pendingTimer = undefined;
  }
  runtime.pendingOutbound.length = 0;
}

function schedulePendingTimeout(
  runtime: WebRemoteControlRuntime,
  logger: WebRemoteControlLogger,
): void {
  if (runtime.pendingTimer) return;
  runtime.pendingTimer = setTimeout(() => {
    runtime.pendingTimer = undefined;
    const dropped = runtime.pendingOutbound.length;
    runtime.pendingOutbound.length = 0;
    if (dropped > 0) {
      logger.warn("[web-remote-control] dropped buffered outbound payloads", {
        windowId: runtime.windowId,
        droppedCount: dropped,
      });
    }
  }, PENDING_OUTBOUND_TIMEOUT_MS);
  runtime.pendingTimer.unref?.();
}

export function sendAppPayload(
  runtime: WebRemoteControlRuntime,
  payload: WebRemoteControlAppPayload,
  logger: WebRemoteControlLogger,
): void {
  if (runtime.mobileConnected && runtime.transport.sendPayload(payload)) {
    return;
  }
  if (runtime.pendingOutbound.length >= MAX_PENDING_OUTBOUND) {
    const dropped = runtime.pendingOutbound.length + 1;
    runtime.pendingOutbound.length = 0;
    logger.warn("[web-remote-control] dropped overflowing outbound payloads", {
      windowId: runtime.windowId,
      droppedCount: dropped,
    });
    return;
  }
  runtime.pendingOutbound.push(payload);
  schedulePendingTimeout(runtime, logger);
}

export function flushPendingOutbound(
  runtime: WebRemoteControlRuntime,
  logger: WebRemoteControlLogger,
): void {
  while (runtime.pendingOutbound.length > 0) {
    const payload = runtime.pendingOutbound[0];
    if (!payload) break;
    if (!runtime.transport.sendPayload(payload)) {
      schedulePendingTimeout(runtime, logger);
      return;
    }
    runtime.pendingOutbound.shift();
  }
  clearPendingOutbound(runtime);
}
