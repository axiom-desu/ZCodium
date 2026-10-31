import { describe, expect, it, vi } from "vitest";
import {
  applyTaskbarOverlayToWindows,
  blendBadgeIntoBitmap,
  createWindowsTaskbarOverlayApplier,
  maxWindowUnreadCounts,
  parseWindowUnreadCount,
  renderAntialiasedStatusDotPixels,
  renderTaskbarStatusDotPixels,
  resolveBadgeOverlayLabel,
  supportsAppUnreadBadge,
  supportsWindowOverlayBadge,
  syncUnreadBadgeForPlatform,
  type TaskbarOverlayWindow,
} from "./unreadBadge.js";

const SOLID_RED_BGRA = [53, 57, 229, 255];

function pixelAt(pixels: Uint8Array, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4;
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}

function createFakeWindow(options: { destroyed?: boolean } = {}): TaskbarOverlayWindow & {
  overlays: Array<{ image: unknown; description: string }>;
} {
  const overlays: Array<{ image: unknown; description: string }> = [];
  return {
    isDestroyed: () => Boolean(options.destroyed),
    setOverlayIcon: (image, description) => {
      overlays.push({ image, description });
    },
    overlays,
  };
}

describe("unread badge aggregation", () => {
  it("只接受非负整数的窗口未读数上报", () => {
    expect(parseWindowUnreadCount(0)).toBe(0);
    expect(parseWindowUnreadCount(3)).toBe(3);
    expect(parseWindowUnreadCount(-1)).toBeNull();
    expect(parseWindowUnreadCount(1.5)).toBeNull();
    expect(parseWindowUnreadCount("2")).toBeNull();
  });

  it("多窗口上报同一全局计数，聚合取 max 防止多主窗口翻倍", () => {
    expect(
      maxWindowUnreadCounts(
        new Map([
          [1, 3],
          [2, 3],
          [3, 0],
        ]),
      ),
    ).toBe(3);
    expect(maxWindowUnreadCounts(new Map())).toBe(0);
  });

  it("平台能力：macOS/Linux 使用应用级 badge，Windows 使用窗口 overlay", () => {
    expect(supportsAppUnreadBadge("darwin")).toBe(true);
    expect(supportsAppUnreadBadge("linux")).toBe(true);
    expect(supportsAppUnreadBadge("win32")).toBe(false);
    expect(supportsWindowOverlayBadge("win32")).toBe(true);
    expect(supportsWindowOverlayBadge("darwin")).toBe(false);
  });

  it("角标文案：0 清除、1~9 原样、10 以上折叠为 9+", () => {
    expect(resolveBadgeOverlayLabel(0)).toBeNull();
    expect(resolveBadgeOverlayLabel(7)).toBe("7");
    expect(resolveBadgeOverlayLabel(9)).toBe("9");
    expect(resolveBadgeOverlayLabel(10)).toBe("9+");
    expect(resolveBadgeOverlayLabel(999)).toBe("9+");
    expect(resolveBadgeOverlayLabel(-3)).toBeNull();
  });

  it("平台分叉：macOS/Linux 写 app badge，不碰 overlay", () => {
    const setBadgeCount = vi.fn();
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "darwin",
      totalUnreadCount: 4,
      setBadgeCount,
      applyOverlay,
    });

    expect(setBadgeCount).toHaveBeenCalledWith(4);
    expect(applyOverlay).not.toHaveBeenCalled();
  });

  it("平台分叉：Windows 写 overlay 文案，不碰 app badge", () => {
    const setBadgeCount = vi.fn();
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "win32",
      totalUnreadCount: 3,
      setBadgeCount,
      applyOverlay,
    });

    expect(applyOverlay).toHaveBeenCalledWith("3");
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it("Windows 未读归零时下发 null 以移除 overlay", () => {
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "win32",
      totalUnreadCount: 0,
      setBadgeCount: vi.fn(),
      applyOverlay,
    });

    expect(applyOverlay).toHaveBeenCalledWith(null);
  });
});

describe("renderTaskbarStatusDotPixels", () => {
  it("输出 Windows 原生 16px overlay 表示，边缘存在部分透明像素", () => {
    const pixels = renderTaskbarStatusDotPixels(1);
    expect(pixels.length).toBe(16 * 16 * 4);

    let antialiasedPixels = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset]!;
      if (alpha > 0 && alpha < 255) antialiasedPixels += 1;
    }
    expect(antialiasedPixels).toBeGreaterThan(0);
  });

  it("2x 高 DPI 表示尺寸为 32px，两种布局均按比例扩展", () => {
    for (const [layout, center] of [
      ["windows-11", 16],
      ["windows-10", 22],
    ] as const) {
      const pixels = renderTaskbarStatusDotPixels(2, layout);
      expect(pixels.length).toBe(32 * 32 * 4);
      expect(pixelAt(pixels, 32, center, center)).toEqual(SOLID_RED_BGRA);
      expect(pixelAt(pixels, 32, 0, 0)).toEqual([0, 0, 0, 0]);
    }
  });

  it("Win11 在画布内居中，Win10 右下锚定，两套圆心不能退化成一个", () => {
    const win11 = renderTaskbarStatusDotPixels(1, "windows-11");
    const win10 = renderTaskbarStatusDotPixels(1, "windows-10");

    expect(pixelAt(win11, 16, 8, 8)).toEqual(SOLID_RED_BGRA);
    expect(pixelAt(win10, 16, 11, 11)).toEqual(SOLID_RED_BGRA);
    expect(pixelAt(win10, 16, 8, 8)).not.toEqual(SOLID_RED_BGRA);
  });

  it("预乘 alpha 不越界：通道值不超过 alpha，圆外完全透明", () => {
    const pixels = renderAntialiasedStatusDotPixels({
      size: 12,
      centerX: 5.5,
      centerY: 5.5,
      radius: 4.25,
    });

    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3]!;
      expect(pixels[offset]!).toBeLessThanOrEqual(alpha);
      expect(pixels[offset + 1]!).toBeLessThanOrEqual(alpha);
      expect(pixels[offset + 2]!).toBeLessThanOrEqual(alpha);
    }

    // 分数半径产生抗锯齿边缘，而不是全有/全无的硬边圆。
    const alphas = new Set<number>();
    for (let offset = 3; offset < pixels.length; offset += 4) {
      alphas.add(pixels[offset]!);
    }
    expect([...alphas].some((alpha) => alpha > 0 && alpha < 255)).toBe(true);
    expect(pixelAt(pixels, 12, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("applyTaskbarOverlayToWindows", () => {
  it("把角标图和数量描述同步到所有存活窗口", () => {
    const winA = createFakeWindow();
    const winB = createFakeWindow();
    const image = { __badge: true };

    applyTaskbarOverlayToWindows({
      label: "3",
      windows: [winA, winB],
      badgeImageForLabel: () => image,
    });

    expect(winA.overlays).toEqual([{ image, description: "3 unread tasks" }]);
    expect(winB.overlays).toEqual([{ image, description: "3 unread tasks" }]);
  });

  it("label 为 null 时清除 overlay 且不生成徽章图", () => {
    const win = createFakeWindow();
    const badgeImageForLabel = vi.fn();

    applyTaskbarOverlayToWindows({
      label: null,
      windows: [win],
      badgeImageForLabel,
    });

    expect(win.overlays).toEqual([{ image: null, description: "" }]);
    expect(badgeImageForLabel).not.toHaveBeenCalled();
  });

  it("跳过已销毁的窗口", () => {
    const alive = createFakeWindow();
    const destroyed = createFakeWindow({ destroyed: true });

    applyTaskbarOverlayToWindows({
      label: "1",
      windows: [destroyed, alive],
      badgeImageForLabel: () => ({ __badge: true }),
    });

    expect(destroyed.overlays).toHaveLength(0);
    expect(alive.overlays).toHaveLength(1);
  });
});

describe("createWindowsTaskbarOverlayApplier", () => {
  it("遍历注入的全部窗口并按 label 缓存徽章图", () => {
    const winA = createFakeWindow();
    const winB = createFakeWindow();
    const createBadgeImage = vi.fn(() => ({ __badge: true }));
    const applier = createWindowsTaskbarOverlayApplier({
      getAllWindows: () => [winA, winB],
      createBadgeImage,
    });

    applier("2");
    applier("2");

    expect(createBadgeImage).toHaveBeenCalledTimes(1);
    expect(createBadgeImage).toHaveBeenCalledWith("2");
    const expectedImage = { __badge: true };
    expect(winA.overlays).toEqual([
      { image: expectedImage, description: "2 unread tasks" },
      { image: expectedImage, description: "2 unread tasks" },
    ]);
    expect(winB.overlays).toHaveLength(2);
  });

  it("label 为 null 时对所有窗口下发 null 清除角标", () => {
    const win = createFakeWindow();
    const applier = createWindowsTaskbarOverlayApplier({
      getAllWindows: () => [win],
      createBadgeImage: vi.fn(),
    });

    applier(null);

    expect(win.overlays).toEqual([{ image: null, description: "" }]);
  });
});

describe("blendBadgeIntoBitmap", () => {
  const SIZE = 4;

  function fillBase(): Uint8Array {
    // 4×4 不透明蓝底（预乘 BGRA：B=200, G=40, R=10, A=255）
    const base = new Uint8Array(SIZE * SIZE * 4);
    for (let offset = 0; offset < base.length; offset += 4) {
      base[offset] = 200;
      base[offset + 1] = 40;
      base[offset + 2] = 10;
      base[offset + 3] = 255;
    }
    return base;
  }

  function solidBadge(value: { b: number; g: number; r: number; a: number }): Uint8Array {
    const badge = new Uint8Array(2 * 2 * 4);
    for (let offset = 0; offset < badge.length; offset += 4) {
      badge[offset] = value.b;
      badge[offset + 1] = value.g;
      badge[offset + 2] = value.r;
      badge[offset + 3] = value.a;
    }
    return badge;
  }

  function pixel(buffer: Uint8Array, x: number, y: number): number[] {
    const offset = (y * SIZE + x) * 4;
    return [buffer[offset]!, buffer[offset + 1]!, buffer[offset + 2]!, buffer[offset + 3]!];
  }

  it("不透明徽章完全覆盖目标区域，其余像素不受影响", () => {
    const base = fillBase();
    blendBadgeIntoBitmap({
      base,
      size: SIZE,
      badge: solidBadge({ b: 1, g: 2, r: 3, a: 255 }),
      badgeSize: 2,
      originX: 2,
      originY: 2,
    });

    expect(pixel(base, 2, 2)).toEqual([1, 2, 3, 255]);
    expect(pixel(base, 3, 3)).toEqual([1, 2, 3, 255]);
    expect(pixel(base, 0, 0)).toEqual([200, 40, 10, 255]);
  });

  it("半透明徽章按预乘 alpha 混合：out = src + dst × (1 - srcA)", () => {
    const base = fillBase();
    blendBadgeIntoBitmap({
      base,
      size: SIZE,
      badge: solidBadge({ b: 100, g: 0, r: 0, a: 128 }),
      badgeSize: 2,
      originX: 0,
      originY: 0,
    });

    const [b, g, r, a] = pixel(base, 0, 0);
    expect(a).toBe(255);
    expect(b).toBe(Math.round(100 + 200 * ((255 - 128) / 255)));
    expect(g).toBe(Math.round(0 + 40 * ((255 - 128) / 255)));
    expect(r).toBe(Math.round(0 + 10 * ((255 - 128) / 255)));
  });

  it("透明徽章不改动底图，越界区域安全裁剪", () => {
    const base = fillBase();
    const badge = new Uint8Array(2 * 2 * 4);
    blendBadgeIntoBitmap({
      base,
      size: SIZE,
      badge,
      badgeSize: 2,
      originX: 3,
      originY: 3,
    });

    expect(pixel(base, 0, 0)).toEqual([200, 40, 10, 255]);
    expect(pixel(base, 3, 3)).toEqual([200, 40, 10, 255]);
  });
});
