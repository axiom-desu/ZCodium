import type { BrowserGuestExecutionContext } from "./browserView/browserGuestManager.js";

/** 截图只有「当前 tab 的当前代 guest」可发起；owner/window/workspace/session/generation 都来自既有 manager。 */
export type CaptureGuestBinding = Pick<
  BrowserGuestExecutionContext,
  "windowId" | "workspaceKey" | "sessionId" | "browserGeneration"
> & { tabId: string };

type CaptureGuestRejectReason = "guest_not_found" | "guest_not_owned";

export interface CaptureGuestLookup {
  guestExists: boolean;
  guestDestroyed: boolean;
  /** guest 的宿主（renderer）webContents id；跨窗口截图必须在这里失败。 */
  hostWebContentsId: number | null;
  senderWebContentsId: number;
  senderWindowId: number | null;
  /** 由 BrowserGuestManager.getTabOwnerByWebContentsId 反查；null 表示 tab 已关闭或 guest 已被替换。 */
  binding: CaptureGuestBinding | null;
}

type CaptureGuestDecision =
  | { ok: true; binding: CaptureGuestBinding }
  | { ok: false; reason: CaptureGuestRejectReason };

/** renderer 只能给出 guest id；负数、小数和 0 都不是有效 webContents id。 */
export function isValidGuestWebContentsId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 取帧前的准入判定（纯函数，便于无 Electron 测试）。
 *
 * - guest 不存在/已销毁：`guest_not_found`
 * - 发起 renderer 不是 guest 的宿主窗口、找不到宿主窗口：`guest_not_owned`
 * - 既有 manager 里已不是该 tab 的当前 guest（关闭、换代、挂起后未恢复）：`guest_not_owned`
 * - owner 的窗口/workspace/session/generation 缺失或不匹配：`guest_not_owned`
 *
 * 任何一项不满足都不取帧，避免关闭中的 tab 继续产出帧或跨窗口截别人的页面。
 */
export function resolveCaptureGuestBinding(lookup: CaptureGuestLookup): CaptureGuestDecision {
  if (!lookup.guestExists || lookup.guestDestroyed) {
    return { ok: false, reason: "guest_not_found" };
  }
  if (
    lookup.senderWindowId === null ||
    lookup.hostWebContentsId === null ||
    lookup.hostWebContentsId !== lookup.senderWebContentsId
  ) {
    return { ok: false, reason: "guest_not_owned" };
  }
  const binding = lookup.binding;
  if (!binding) return { ok: false, reason: "guest_not_owned" };
  const hasIdentity =
    Number.isInteger(binding.browserGeneration) &&
    binding.browserGeneration > 0 &&
    binding.workspaceKey.trim().length > 0 &&
    binding.sessionId.trim().length > 0;
  if (!hasIdentity || binding.windowId !== lookup.senderWindowId) {
    return { ok: false, reason: "guest_not_owned" };
  }
  return { ok: true, binding };
}
