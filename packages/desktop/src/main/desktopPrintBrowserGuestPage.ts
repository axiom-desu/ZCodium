import type { PrintBrowserGuestPageRequest, PrintBrowserGuestPageResult } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { BrowserWindow, ipcMain, webContents } from "electron";
import {
  isValidGuestWebContentsId,
  resolveCaptureGuestBinding,
  type CaptureGuestBinding,
} from "./desktopCaptureBrowserGuestPagePolicy.js";

/**
 * 内置浏览器「导出 PDF」在 main 打印 guest 页面。
 *
 * renderer 侧不使用 `<webview>.printToPDF`：owner/workspace/session/generation 校验、同一 guest 的
 * 串行化与超时必须和截图一样收在 main 一处，否则任意 renderer 都能打印别的窗口的 tab。
 * 校验直接复用截图模块的纯函数 `resolveCaptureGuestBinding`（BN5 拥有该策略，本模块只消费）。
 */

/** 同一 guest 只允许一个打印任务在途：Chromium 打印管线对并发非常敏感。 */
const inFlightPrints = new Set<number>();

/** 打印有独立的有界等待；超时后释放占位，返回 print_timeout（底层仍可能迟到结算）。 */
const PRINT_DEADLINE_MS = 30_000;

interface DesktopPrintBrowserGuestPageOptions {
  logger: { warn: (...args: unknown[]) => void };
  /** 由既有 BrowserGuestManager 提供；缺省时一律按 guest_not_owned 失败关闭。 */
  resolveGuestBinding?: (webContentsId: number) => CaptureGuestBinding | null;
}

export function registerDesktopPrintBrowserGuestPageIpcHandler(
  options: DesktopPrintBrowserGuestPageOptions,
) {
  ipcMain.handle(
    PlatformChannels.PrintBrowserGuestPage,
    async (event, payload: PrintBrowserGuestPageRequest): Promise<PrintBrowserGuestPageResult> => {
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
          `[print-browser-guest-page] 拒绝打印 guest=${guestId} reason=${decision.ok ? "guest_not_found" : decision.reason}`,
        );
        return { success: false, error: decision.ok ? "guest_not_found" : decision.reason };
      }
      if (inFlightPrints.has(guestId)) {
        options.logger.warn(`[print-browser-guest-page] 拒绝重复打印 guest=${guestId}`);
        return { success: false, error: "print_in_progress" };
      }
      inFlightPrints.add(guestId);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const pdf = await Promise.race([
          guest.printToPDF({
            printBackground: true,
            // 页面尺寸由页面自己的 @page CSS 决定，与既有 printPageToPdf 语义一致。
            preferCSSPageSize: true,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("print_timeout")), PRINT_DEADLINE_MS);
          }),
        ]);
        if (pdf.byteLength === 0) {
          return { success: false, error: "print_failed" };
        }
        const bytes = new Uint8Array(pdf);
        // Buffer 可能是池化视图，切出独立 ArrayBuffer 再走 structured clone。
        return {
          success: true,
          data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn(
          `[print-browser-guest-page] 打印失败 guest=${guestId} tab=${decision.binding.tabId} error=${message}`,
        );
        return {
          success: false,
          error: message === "print_timeout" ? "print_timeout" : "print_failed",
        };
      } finally {
        if (deadline) clearTimeout(deadline);
        inFlightPrints.delete(guestId);
      }
    },
  );
}
