import type { CaptureBrowserGuestPageRequest, CaptureBrowserGuestPageResult } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { BrowserWindow, ipcMain, webContents } from "electron";
import { resolveGuestCaptureCropRect } from "./desktopCaptureBrowserGuestPageCrop.js";
import {
  isValidGuestWebContentsId,
  resolveCaptureGuestBinding,
  type CaptureGuestBinding,
} from "./desktopCaptureBrowserGuestPagePolicy.js";

/**
 * 同一 guest 的截图请求串行化，与 renderer 侧「导出中」互斥互为兜底。`late` 表示这次已超时返回、
 * 底层 capturePage 还没结算（迟到中）。
 */
const inFlightCaptures = new Map<number, { late: boolean }>();

/** 隐藏/被遮挡的窗口可能永远不出帧；有界等待让 renderer 侧的导出互斥能解锁 */
const CAPTURE_DEADLINE_MS = 15_000;

/**
 * 从发起算起，迟到的取帧最多占住该 guest 这么久。超时后底层 capturePage 还在跑时不叠加新的取帧，
 * 但它可能永不结算（窗口一直隐藏/被遮挡），到点强制释放，否则这个 guest 再也截不了图。
 */
const LATE_CAPTURE_RELEASE_MS = 2 * CAPTURE_DEADLINE_MS;

interface DesktopCaptureBrowserGuestPageOptions {
  logger: { warn: (...args: unknown[]) => void };
  /**
   * 由 BrowserGuestManager 提供（`getTabOwnerByWebContentsId`）：把 guest webContents id 反查当前
   * owner/workspace/session/generation。缺省时一律按 `guest_not_owned` 失败关闭，不回退成只比窗口。
   */
  resolveGuestBinding?: (webContentsId: number) => CaptureGuestBinding | null;
}

/**
 * 内置浏览器「导出为 PNG」与「选元素截图」在 main 取帧。
 * renderer 侧直接调 `<webview>.capturePage()` 会让 renderer 原生崩溃（V8 FATAL，与 Agent 截图
 * 规避的是同一个坑），所以人类用户导出和 Agent 截图一样只能由 main 对 guest webContents 取帧。
 * 只允许嵌入该 guest 的窗口（hostWebContents === sender）发起，且该 guest 必须仍是既有
 * BrowserGuestManager 中该 tab 的当前 guest，防止任意 renderer 截别的窗口或截关闭中的 tab。
 */
export function registerDesktopCaptureBrowserGuestPageIpcHandler(
  options: DesktopCaptureBrowserGuestPageOptions,
) {
  ipcMain.handle(
    PlatformChannels.CaptureBrowserGuestPage,
    async (
      event,
      payload: CaptureBrowserGuestPageRequest,
    ): Promise<CaptureBrowserGuestPageResult> => {
      const guestId = payload?.webContentsId;
      if (!isValidGuestWebContentsId(guestId)) {
        return { success: false, error: "guest_not_found" };
      }
      const guest = webContents.fromId(guestId);
      const guestExists = Boolean(guest);
      const guestDestroyed = guest ? guest.isDestroyed() : true;
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const decision = resolveCaptureGuestBinding({
        guestExists,
        guestDestroyed,
        hostWebContentsId: guest?.hostWebContents?.id ?? null,
        senderWebContentsId: event.sender.id,
        senderWindowId: senderWindow && !senderWindow.isDestroyed() ? senderWindow.id : null,
        binding: options.resolveGuestBinding?.(guestId) ?? null,
      });
      if (!decision.ok || !guest) {
        options.logger.warn(
          `[capture-browser-guest-page] 拒绝截图 guest=${guestId} reason=${decision.ok ? "guest_not_found" : decision.reason}`,
        );
        return { success: false, error: decision.ok ? "guest_not_found" : decision.reason };
      }
      const busy = inFlightCaptures.get(guestId);
      if (busy) {
        if (busy.late) {
          options.logger.warn(
            `[capture-browser-guest-page] 拒绝新的截图：上一次已超时、底层取帧尚未结算 guest=${guestId}`,
          );
        }
        return { success: false, error: "capture_in_progress" };
      }
      const entry = { late: false };
      inFlightCaptures.set(guestId, entry);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let lateRelease: ReturnType<typeof setTimeout> | undefined;
      // 超时只结束这次等待；底层取帧结算（含超时后迟到的那次）之前，同一 guest 继续回 capture_in_progress，
      // 不叠加新的 capturePage。释放来源三选一，先到先放：底层结算（含同步抛错）、guest 销毁（关闭/换代）、
      // 迟到超过上限强制释放。
      const release = () => {
        if (lateRelease) clearTimeout(lateRelease);
        guest.removeListener("destroyed", release);
        if (inFlightCaptures.get(guestId) === entry) inFlightCaptures.delete(guestId);
      };
      guest.once("destroyed", release);
      const capture = (async () => guest.capturePage())();
      void capture.then(release, release);
      try {
        const image = await Promise.race([
          capture,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("capture_timeout")), CAPTURE_DEADLINE_MS);
          }),
        ]);
        let frame = image;
        if (payload.clip) {
          // 先取整帧再裁：与导出 PNG 同一条已验证的取帧路径，不另走 CDP，也不进入 Agent 截图临界区。
          const crop = resolveGuestCaptureCropRect(payload.clip, image.getSize());
          if (!crop) return { success: false, error: "clip_out_of_view" };
          frame = image.crop(crop);
        }
        const png = frame.toPNG();
        if (png.byteLength === 0) {
          return { success: false, error: "capture_failed" };
        }
        // Buffer 可能是池化视图，切出独立 ArrayBuffer 再走 structured clone
        return { success: true, data: Uint8Array.from(png).buffer };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn(
          `[capture-browser-guest-page] 截图失败 guest=${guestId} tab=${decision.binding.tabId} error=${message}`,
        );
        if (message === "capture_timeout" && inFlightCaptures.get(guestId) === entry) {
          entry.late = true;
          lateRelease = setTimeout(() => {
            if (inFlightCaptures.get(guestId) !== entry) return;
            options.logger.warn(
              `[capture-browser-guest-page] 迟到的取帧超过 ${LATE_CAPTURE_RELEASE_MS}ms 仍未结算，强制释放 guest=${guestId}`,
            );
            release();
          }, LATE_CAPTURE_RELEASE_MS - CAPTURE_DEADLINE_MS);
        }
        return {
          success: false,
          error: message === "capture_timeout" ? "capture_timeout" : "capture_failed",
        };
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    },
  );
}
