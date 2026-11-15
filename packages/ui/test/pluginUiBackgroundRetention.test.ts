import { describe, expect, it } from "vitest";
import { PluginUiBackgroundRetention } from "@/plugin-ui/app/pluginUiBackgroundRetention.js";

interface FakePage {
  name: string;
  visible: boolean;
  suspensions: number;
  busy(): boolean;
  running(): boolean;
  suspend(): Promise<boolean>;
}

function createPage(
  name: string,
  overrides: { visible?: boolean; busy?: boolean; running?: boolean } = {},
): FakePage {
  const state = { visible: false, busy: false, running: true, suspensions: 0, ...overrides };
  return {
    name,
    get visible() {
      return state.visible;
    },
    set visible(value: boolean) {
      state.visible = value;
    },
    get suspensions() {
      return state.suspensions;
    },
    busy: () => state.busy,
    running: () => state.running,
    suspend: async () => {
      state.suspensions += 1;
      // 真实页面回收后 controller 被释放；这里同步停止 running，避免同一轮重复回收。
      state.running = false;
      return true;
    },
  };
}

function createClock() {
  let now = 0;
  const timers: { run: () => void; at: number; cancelled: boolean }[] = [];
  return {
    now: () => now,
    timer: (run: () => void, ms: number) => {
      const entry = { run, at: now + ms, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const entry of timers) {
        if (!entry.cancelled && entry.at <= now) {
          entry.cancelled = true;
          entry.run();
        }
      }
    },
    pending: () => timers.filter((entry) => !entry.cancelled).length,
  };
}

async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("PluginUiBackgroundRetention", () => {
  it("四个后台声明页以内不回收", async () => {
    const clock = createClock();
    const retention = new PluginUiBackgroundRetention<FakePage>(clock.timer, clock.now);
    const pages = ["a", "b", "c", "d"].map((name) => createPage(name));
    for (const page of pages) retention.register(page);
    clock.advance(60 * 60_000);
    for (const page of pages) retention.activity(page);
    await flush();
    expect(pages.every((page) => page.suspensions === 0)).toBe(true);
  });

  it("超过四个后台页时回收最久未活跃且不忙的页面", async () => {
    const clock = createClock();
    const retention = new PluginUiBackgroundRetention<FakePage>(clock.timer, clock.now);
    const oldest = createPage("oldest");
    retention.register(oldest);
    clock.advance(31 * 60_000);
    const newer = ["b", "c", "d", "e"].map((name) => createPage(name));
    for (const page of newer) {
      retention.register(page);
      clock.advance(1_000);
    }
    await flush();
    expect(oldest.suspensions).toBe(1);
    expect(newer.every((page) => page.suspensions === 0)).toBe(true);
  });

  it("全部候选忙碌时不回收，也不安排零延时重试", async () => {
    const clock = createClock();
    const retention = new PluginUiBackgroundRetention<FakePage>(clock.timer, clock.now);
    const pages = ["a", "b", "c", "d", "e"].map((name) => createPage(name, { busy: true }));
    for (const page of pages) retention.register(page);
    await flush();
    expect(pages.every((page) => page.suspensions === 0)).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it("claim 先占名额，并发请求不会重复回收同一页", () => {
    const clock = createClock();
    const retention = new PluginUiBackgroundRetention<FakePage>(clock.timer, clock.now);
    const pages = ["a", "b", "c", "d", "e"].map((name) => createPage(name));
    for (const page of pages) retention.register(page);
    clock.advance(31 * 60_000);
    expect(retention.claim(pages[0]!)).toBe(true);
    expect(retention.claim(pages[0]!)).toBe(false);
    // 预占期间后台计数下降，避免同时淘汰到四个以下。
    expect(retention.canRecycle(pages[1]!)).toBe(false);
    retention.finish(pages[0]!);
    expect(retention.claim(pages[1]!)).toBe(true);
  });

  it("可见页在窗口可见期不累计闲置；最小化后重新计时", () => {
    const clock = createClock();
    const retention = new PluginUiBackgroundRetention<FakePage>(clock.timer, clock.now);
    retention.setWindowVisible(true);
    const pages = ["a", "b", "c", "d"].map((name) => createPage(name));
    const visible = createPage("visible", { visible: true });
    visible.visible = true;
    for (const page of [...pages, visible]) retention.register(page);
    clock.advance(45 * 60_000);
    // 窗口可见时可见页不计入后台集合，也不可能被回收。
    expect(retention.canRecycle(visible)).toBe(false);
    retention.setWindowVisible(false);
    expect(retention.canRecycle(visible)).toBe(false);
    clock.advance(29 * 60_000);
    expect(retention.canRecycle(visible)).toBe(false);
    clock.advance(2 * 60_000);
    expect(retention.canRecycle(visible)).toBe(true);
  });

  it("activity 续期已注册页面，release 后不再参与回收", () => {
    const clock = createClock();
    const retention = new PluginUiBackgroundRetention<FakePage>(clock.timer, clock.now);
    const pages = ["a", "b", "c", "d", "e"].map((name) => createPage(name));
    for (const page of pages) retention.register(page);
    clock.advance(25 * 60_000);
    retention.activity(pages[0]!);
    clock.advance(10 * 60_000);
    expect(retention.canRecycle(pages[0]!)).toBe(false);
    retention.release(pages[0]!);
    // 释放后不再被策略管理；claim 直接放行。
    expect(retention.claim(pages[0]!)).toBe(true);
  });
});
