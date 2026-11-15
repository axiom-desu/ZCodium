import { describe, expect, it, vi } from "vitest";
import { createAppControlNavigationBridge } from "../src/app-control-navigation/hostBridge.js";
import { createAppControlNavigationWindow } from "../src/app-control-navigation/windowBridge.js";
import type {
  AppNavigationHostMessage,
  AppNavigationSource,
} from "../src/app-control-navigation/contract.js";

function source(results: unknown[]): AppNavigationSource {
  return {
    reply: (message) => {
      results.push(message);
    },
  };
}

describe("app control navigation window bridge", () => {
  it("未登记 renderer 时立即 unavailable，且不发送 open", () => {
    const sent: unknown[] = [];
    const surface = createAppControlNavigationWindow({
      uiTarget: "window:1",
      send: (message) => sent.push(message),
    });
    const replies: unknown[] = [];
    surface.open(source(replies), {
      type: "app-navigation-open",
      requestId: "r1",
      target: { workspacePath: "/w", taskId: "s1" },
    });
    expect(sent).toEqual([]);
    expect(replies).toMatchObject([
      { result: { status: "unavailable", reason: "renderer-unavailable" } },
    ]);
  });

  it("generation 替换后旧回执不能被新请求接受，关闭/relogin 清空 pending", () => {
    const sent: Array<{ type: string; requestId?: string; generation?: string }> = [];
    const surface = createAppControlNavigationWindow({
      uiTarget: "window:1",
      send: (message) => sent.push(message as never),
    });
    surface.register("g1");
    const replies: unknown[] = [];
    const first = source(replies);
    surface.open(first, {
      type: "app-navigation-open",
      requestId: "r1",
      target: { workspacePath: "/w", taskId: "s1" },
    });
    expect(sent.at(-1)).toMatchObject({ type: "open", requestId: "r1", generation: "g1" });
    // reload：g1 的全部在途请求被取消并回执 unavailable。
    surface.register("g2");
    expect(sent.at(-1)).toMatchObject({ type: "cancel", requestId: "r1", generation: "g1" });
    expect(replies.at(-1)).toMatchObject({
      result: { status: "unavailable", reason: "renderer-replaced" },
    });
    // 旧回执（即使 requestId 重名）不会结束 g2 下的新请求。
    const second = source(replies);
    surface.open(second, {
      type: "app-navigation-open",
      requestId: "r1",
      target: { workspacePath: "/w", taskId: "s1" },
    });
    const count = replies.length;
    surface.complete({ requestId: "r1", generation: "g1", result: { status: "opened" } });
    expect(replies.length).toBe(count);
    surface.complete({
      requestId: "r1",
      generation: "g2",
      result: { status: "opened", uiTarget: "window:1" },
    });
    expect(replies.at(-1)).toMatchObject({ result: { status: "opened", uiTarget: "window:1" } });

    // 窗口关闭：任何仍在途的请求都被取消，不再等待回执。
    const third = source(replies);
    surface.open(third, {
      type: "app-navigation-open",
      requestId: "r3",
      target: { workspacePath: "/w", taskId: "s1" },
    });
    surface.dispose();
    expect(replies.at(-1)).toMatchObject({
      result: { status: "unavailable", reason: "window-closed" },
    });
  });

  it("显式 uiTarget 与窗口绑定不符时拒绝，不回落到当前窗口", () => {
    const sent: unknown[] = [];
    const surface = createAppControlNavigationWindow({
      uiTarget: "window:1",
      send: (message) => sent.push(message),
    });
    surface.register("g1");
    const replies: unknown[] = [];
    surface.open(source(replies), {
      type: "app-navigation-open",
      requestId: "r1",
      uiTarget: "window:2",
      target: { workspacePath: "/w", taskId: "s1" },
    });
    expect(sent).toEqual([]);
    expect(replies).toMatchObject([
      { result: { status: "unavailable", reason: "ui-target-unavailable" } },
    ]);
  });
});

describe("app control navigation host bridge", () => {
  it("Host dispose 取消在途导航并释放等待者，回执不会再次 settle", async () => {
    const posted: AppNavigationHostMessage[] = [];
    const bridge = createAppControlNavigationBridge({ post: (message) => posted.push(message) });
    const controller = new AbortController();
    const pending = bridge.openSession({
      session: { sessionId: "s1", workspacePath: "/w" },
      binding: {
        connectionId: "c1",
        sourceServerId: "local",
        signal: controller.signal,
        assertCurrent: () => undefined,
      },
    });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const requestId = (posted[0] as { requestId: string }).requestId;
    bridge.dispose();
    await expect(pending).resolves.toMatchObject({
      status: "unavailable",
      reason: "host-disposed",
    });
    expect(posted.at(-1)).toEqual({ type: "app-navigation-cancel", requestId });
    // 关闭后迟到回执被忽略；再次打开明确 unavailable。
    bridge.receive({ type: "app-navigation-result", requestId, result: { status: "opened" } });
    await expect(
      bridge.openSession({
        session: { sessionId: "s1", workspacePath: "/w" },
        binding: {
          connectionId: "c1",
          sourceServerId: "local",
          signal: new AbortController().signal,
          assertCurrent: () => undefined,
        },
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "host-disposed" });
  });

  it("连接代际失效时 openSession 返回 stale-connection 且不发消息", async () => {
    const posted: AppNavigationHostMessage[] = [];
    const bridge = createAppControlNavigationBridge({ post: (message) => posted.push(message) });
    await expect(
      bridge.openSession({
        session: { sessionId: "s1", workspacePath: "/w" },
        binding: {
          connectionId: "c1",
          sourceServerId: "local",
          signal: new AbortController().signal,
          assertCurrent: () => {
            throw new Error("stale");
          },
        },
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "stale-connection" });
    expect(posted).toEqual([]);
  });
});
