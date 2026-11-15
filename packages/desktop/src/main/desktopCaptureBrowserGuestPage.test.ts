import { describe, expect, it } from "vitest";
import { resolveGuestCaptureCropRect } from "./desktopCaptureBrowserGuestPageCrop.js";
import {
  isValidGuestWebContentsId,
  resolveCaptureGuestBinding,
  type CaptureGuestLookup,
} from "./desktopCaptureBrowserGuestPagePolicy.js";

const clip = (overrides: Partial<Parameters<typeof resolveGuestCaptureCropRect>[0]> = {}) => ({
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  viewportWidth: 400,
  viewportHeight: 300,
  ...overrides,
});

describe("resolveGuestCaptureCropRect", () => {
  it("按实测帧/CSS 比例裁剪，兼容 2x Retina 帧", () => {
    expect(resolveGuestCaptureCropRect(clip(), { width: 800, height: 600 })).toEqual({
      x: 20,
      y: 40,
      width: 200,
      height: 100,
    });
  });

  it("小数 DPR（Windows 125%）向外取整，避免缺一像素边", () => {
    expect(
      resolveGuestCaptureCropRect(clip({ x: 11, y: 21, width: 99, height: 41 }), {
        width: 500,
        height: 375,
      }),
    ).toEqual({ x: 13, y: 26, width: 125, height: 52 });
  });

  it("超出视口的负坐标裁到帧边界", () => {
    expect(
      resolveGuestCaptureCropRect(clip({ x: -30, y: -10, width: 60, height: 40 }), {
        width: 400,
        height: 300,
      }),
    ).toEqual({ x: 0, y: 0, width: 30, height: 30 });
  });

  it("完全不可见或非法数值返回 null", () => {
    expect(
      resolveGuestCaptureCropRect(clip({ x: 500, y: 400 }), { width: 400, height: 300 }),
    ).toBeNull();
    expect(resolveGuestCaptureCropRect(clip({ width: 0 }), { width: 400, height: 300 })).toBeNull();
    expect(
      resolveGuestCaptureCropRect(clip({ viewportWidth: 0 }), { width: 400, height: 300 }),
    ).toBeNull();
    expect(
      resolveGuestCaptureCropRect(clip({ x: Number.NaN }), { width: 400, height: 300 }),
    ).toBeNull();
    expect(
      resolveGuestCaptureCropRect(clip({ height: Number.POSITIVE_INFINITY }), {
        width: 400,
        height: 300,
      }),
    ).toBeNull();
  });
});

const binding = {
  tabId: "tab-1",
  windowId: 7,
  workspaceKey: "/tmp/ws",
  sessionId: "session-1",
  browserGeneration: 3,
};

const lookup = (overrides: Partial<CaptureGuestLookup> = {}): CaptureGuestLookup => ({
  guestExists: true,
  guestDestroyed: false,
  hostWebContentsId: 11,
  senderWebContentsId: 11,
  senderWindowId: 7,
  binding,
  ...overrides,
});

describe("isValidGuestWebContentsId", () => {
  it("只接受正整数 webContents id", () => {
    expect(isValidGuestWebContentsId(3)).toBe(true);
    expect(isValidGuestWebContentsId(0)).toBe(false);
    expect(isValidGuestWebContentsId(-1)).toBe(false);
    expect(isValidGuestWebContentsId(1.5)).toBe(false);
    expect(isValidGuestWebContentsId("3")).toBe(false);
    expect(isValidGuestWebContentsId(undefined)).toBe(false);
  });
});

describe("resolveCaptureGuestBinding", () => {
  it("当前 tab 的当前代 guest 允许取帧", () => {
    expect(resolveCaptureGuestBinding(lookup())).toEqual({ ok: true, binding });
  });

  it("guest 不存在或已销毁返回 guest_not_found（关闭即取消）", () => {
    expect(resolveCaptureGuestBinding(lookup({ guestExists: false }))).toEqual({
      ok: false,
      reason: "guest_not_found",
    });
    expect(resolveCaptureGuestBinding(lookup({ guestDestroyed: true }))).toEqual({
      ok: false,
      reason: "guest_not_found",
    });
  });

  it("发起 renderer 不是 guest 宿主窗口时拒绝跨窗口截图", () => {
    expect(resolveCaptureGuestBinding(lookup({ hostWebContentsId: 12 }))).toEqual({
      ok: false,
      reason: "guest_not_owned",
    });
    expect(resolveCaptureGuestBinding(lookup({ senderWindowId: null }))).toEqual({
      ok: false,
      reason: "guest_not_owned",
    });
    expect(resolveCaptureGuestBinding(lookup({ hostWebContentsId: null }))).toEqual({
      ok: false,
      reason: "guest_not_owned",
    });
  });

  it("guest 已被替换/关闭（manager 查不到归属）时拒绝", () => {
    expect(resolveCaptureGuestBinding(lookup({ binding: null }))).toEqual({
      ok: false,
      reason: "guest_not_owned",
    });
  });

  it("owner 的窗口/workspace/session/generation 不完整或不匹配时拒绝", () => {
    expect(resolveCaptureGuestBinding(lookup({ binding: { ...binding, windowId: 8 } }))).toEqual({
      ok: false,
      reason: "guest_not_owned",
    });
    expect(
      resolveCaptureGuestBinding(lookup({ binding: { ...binding, workspaceKey: "  " } })),
    ).toEqual({ ok: false, reason: "guest_not_owned" });
    expect(resolveCaptureGuestBinding(lookup({ binding: { ...binding, sessionId: "" } }))).toEqual({
      ok: false,
      reason: "guest_not_owned",
    });
    expect(
      resolveCaptureGuestBinding(lookup({ binding: { ...binding, browserGeneration: 0 } })),
    ).toEqual({ ok: false, reason: "guest_not_owned" });
  });
});
