import { describe, expect, it, vi } from "vitest";
import { renderTaskbarNumberPixels } from "./taskbarNumberPixels.js";
import {
  createWindowsTaskbarOverlayApplier,
  maxWindowUnreadCounts,
  resolveBadgeOverlayLabel,
} from "./unreadBadge.js";

describe("Windows visible unread numbers", () => {
  it("16/32 的 1、2、9+ 均为不同白字红底，边缘预乘透明", () => {
    for (const scale of [1, 2] as const) {
      const images = ["1", "2", "9+"].map((label) => renderTaskbarNumberPixels(label, scale));
      expect(images[0]).not.toEqual(images[1]);
      expect(images[1]).not.toEqual(images[2]);
      for (const pixels of images) {
        expect(pixels.length).toBe((16 * scale) ** 2 * 4);
        let white = 0;
        let red = 0;
        let edge = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3]!;
          for (let c = 0; c < 3; c++) expect(pixels[i + c]).toBeLessThanOrEqual(alpha);
          if (alpha === 0) expect(pixels.slice(i, i + 4)).toEqual(new Uint8Array(4));
          if (alpha > 0 && alpha < 255) edge++;
          if (pixels[i] === 255 && alpha === 255) white++;
          if (pixels[i + 2] === 229 && pixels[i] === 53) red++;
        }
        expect(white).toBeGreaterThan(0);
        expect(red).toBeGreaterThan(0);
        expect(edge).toBeGreaterThan(0);
      }
    }
  });

  it("计数更新/窗口关闭只重算 max，0 清除，规范 label 缓存最多十张", () => {
    const counts = new Map([
      [1, 2],
      [2, 12],
    ]);
    const live = { isDestroyed: () => false, setOverlayIcon: vi.fn() };
    const closed = { isDestroyed: () => true, setOverlayIcon: vi.fn() };
    const createBadgeImage = vi.fn((label: string) => ({ label }));
    const apply = createWindowsTaskbarOverlayApplier({
      getAllWindows: () => [live, closed],
      createBadgeImage,
    });
    const sync = () => apply(resolveBadgeOverlayLabel(maxWindowUnreadCounts(counts)));
    sync();
    expect(live.setOverlayIcon).toHaveBeenLastCalledWith({ label: "9+" }, "9+ unread tasks");
    counts.delete(2);
    sync();
    expect(live.setOverlayIcon).toHaveBeenLastCalledWith({ label: "2" }, "2 unread tasks");
    counts.set(1, 1);
    sync();
    counts.clear();
    sync();
    expect(live.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
    for (let round = 0; round < 2; round++) for (let n = 1; n <= 100; n++) apply(String(n));
    apply("invalid");
    expect(live.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
    expect(createBadgeImage).toHaveBeenCalledTimes(10);
    expect(closed.setOverlayIcon).not.toHaveBeenCalled();
  });
});
