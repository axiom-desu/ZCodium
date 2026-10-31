import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectGroupedEdgeScroll } from "./grouped-edge-scroll.js";

function harness() {
  const frames = new Map<number, FrameRequestCallback>();
  let seq = 0;
  let top = 200;
  const viewport = {
    parentElement: null,
    isConnected: true,
    scrollHeight: 1600,
    clientHeight: 300,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.max(0, Math.min(1300, value));
    },
    getBoundingClientRect: () => ({ top: 50, bottom: 350, left: 10, right: 310 }),
  };
  vi.stubGlobal("window", {
    innerHeight: 800,
    getComputedStyle: () => ({ overflowY: "auto" }),
  });
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++seq, fn);
    return seq;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const onScroll = vi.fn();
  const scroll = createProjectGroupedEdgeScroll(
    { parentElement: viewport } as unknown as HTMLElement,
    onScroll,
  );
  const tick = (time: number) => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn(time));
  };
  return { viewport, frames, onScroll, scroll, tick };
}

afterEach(() => vi.unstubAllGlobals());

describe("project grouped edge scroll", () => {
  it("静止指针持续滚真实 viewport，滚动后重新命中落点", () => {
    const h = harness();
    h.scroll.update(100, 348);
    h.tick(0);
    const first = h.viewport.scrollTop;
    h.tick(16);
    expect(first).toBeGreaterThan(200);
    expect(h.viewport.scrollTop).toBeGreaterThan(first);
    expect(h.onScroll).toHaveBeenCalledWith(100, 348);
    h.scroll.update(100, 52);
    h.tick(32);
    expect(h.viewport.scrollTop).toBeLessThan(first + 1);
  });

  it("离开边缘或 viewport、stop 后无后续帧/回调", () => {
    for (const point of [
      [100, 180],
      [400, 348],
      [100, 400],
    ]) {
      const h = harness();
      h.scroll.update(100, 348);
      h.scroll.update(point[0]!, point[1]!);
      h.tick(16);
      expect(h.viewport.scrollTop).toBe(200);
      expect(h.frames.size).toBe(0);
      h.scroll.update(100, 348);
      h.scroll.stop();
      h.tick(32);
      expect(h.frames.size).toBe(0);
      expect(h.onScroll).not.toHaveBeenCalled();
    }
  });

  it("到达边界或 viewport 卸载停止 RAF", () => {
    const h = harness();
    h.viewport.scrollTop = 1300;
    h.scroll.update(100, 348);
    h.tick(0);
    expect(h.frames.size).toBe(0);
    expect(h.onScroll).not.toHaveBeenCalled();
    h.viewport.scrollTop = 200;
    h.scroll.update(100, 348);
    h.viewport.isConnected = false;
    h.tick(16);
    expect(h.viewport.scrollTop).toBe(200);
    expect(h.frames.size).toBe(0);
  });
});
