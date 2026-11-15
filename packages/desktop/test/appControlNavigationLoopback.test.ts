import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserWindow, IpcMain, UtilityProcess, WebContents } from "electron";
import { createAppControlService } from "../../services/src/app-control/index.js";
import { createAppControlRequestHandler } from "../../services/src/app-control/rpc.js";
import type { AppControlTaskRow } from "../../services/src/app-control/contract.js";
import { navigateToAppSession } from "../../ui/src/root/appControlNavigationAction.js";
import { createAppControlNavigationBridge } from "../src/app-control-navigation/hostBridge.js";
import {
  bindAppControlNavigationHost,
  registerAppControlNavigationIpc,
} from "../src/app-control-navigation/electronBridge.js";
import { registerAppControlNavigationHandler } from "../src/app-control-navigation/rendererBridge.js";
import { APP_NAVIGATION_IPC } from "../src/app-control-navigation/contract.js";

const workspacePath = "/tmp/zcode-a6-workspace";
const now = Date.now();
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function task(overrides: Partial<AppControlTaskRow> = {}): AppControlTaskRow {
  return {
    taskId: "sess_a",
    hostId: "local",
    workspacePath,
    projectId: "p1",
    title: "第一章",
    status: "completed",
    updatedAt: now,
    ...overrides,
  };
}

/**
 * 真实生产链的 loopback：Host bridge → Main window surface → preload IPC →
 * renderer handler → Root 公开动作。只替换 Electron 进程边界（EventEmitter / fake WebContents）。
 */
function createLoopback(options?: { navigationTargetWindowId?: number }) {
  const tasks = [task(), task({ taskId: "sess_b", title: "第二章" })];
  const owner = new EventEmitter() as EventEmitter & {
    id: number;
    isDestroyed(): boolean;
    webContents: WebContents;
    once: EventEmitter["once"];
  };
  const rendererMessages: unknown[] = [];
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: { routingId: 1 },
    send: (channel: string, payload: unknown) => {
      expect(channel).toBe(APP_NAVIGATION_IPC);
      rendererMessages.push(payload);
      rendererSubscribers.forEach((listener) => listener(payload));
    },
    isDestroyed: () => false,
  }) as unknown as WebContents & { mainFrame: object };
  Object.assign(owner, {
    id: 7,
    isDestroyed: () => false,
    webContents,
    once: EventEmitter.prototype.once,
  });
  const rendererSubscribers = new Set<(message: unknown) => void>();
  const host = new EventEmitter() as EventEmitter & {
    postMessage(message: unknown): void;
  };
  let ipcListener: ((event: unknown, payload: unknown) => void) | undefined;
  const ipcMain = {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      expect(channel).toBe(APP_NAVIGATION_IPC);
      ipcListener = listener;
    },
  } as unknown as IpcMain;
  registerAppControlNavigationIpc(ipcMain, () => owner as unknown as BrowserWindow);
  disposers.push(
    bindAppControlNavigationHost(
      owner as unknown as BrowserWindow,
      host as unknown as UtilityProcess,
      (id) =>
        id === 7
          ? (owner as unknown as BrowserWindow)
          : (options?.navigationTargetWindowId ?? null),
    ),
  );

  const sendFromRenderer = (payload: unknown) => {
    ipcListener?.({ sender: webContents, senderFrame: webContents.mainFrame }, payload);
  };
  const generation = "generation-1";
  const navigate: Array<{ path: string; taskId: string; identity?: string }> = [];
  disposers.push(
    registerAppControlNavigationHandler(
      {
        subscribe: (listener) => {
          const subscribe = (message: unknown) => listener(message as never);
          rendererSubscribers.add(subscribe);
          return () => rendererSubscribers.delete(subscribe);
        },
        register: (active) => sendFromRenderer({ type: "register", generation: active }),
        unregister: (active) => sendFromRenderer({ type: "unregister", generation: active }),
        reply: (message) => sendFromRenderer({ type: "result", ...message }),
      },
      async (target, signal) => {
        const result = navigateToAppSession(
          {
            activateTabByPath: (path) => path === workspacePath,
            addTab: (path) => {
              throw new Error(`unexpected addTab ${path}`);
            },
            setActiveTaskId: (path, taskId, identity) => {
              navigate.push({ path, taskId, ...(identity ? { identity } : {}) });
            },
          },
          target,
          { signal },
        );
        return { ...result, uiTarget: "window:7" };
      },
      generation,
    ),
  );

  const bridge = createAppControlNavigationBridge({
    post: (message) => host.emit("message", message),
  });
  disposers.push(() => bridge.dispose());
  // Main→Host 回执走真实父端口方向；Host 侧只按 requestId 关联。
  host.postMessage = (message) => {
    const parsed = message as { type?: string };
    if (parsed.type === "app-navigation-result") bridge.receive(message as never);
  };

  const service = createAppControlService({
    sourceServerId: "local",
    projects: {
      async readTree() {
        return {
          projects: [{ id: "p1", hostId: "local", name: "小说", deleted: false }],
          tasks,
        } as never;
      },
      async readProjects() {
        return [{ id: "p1", hostId: "local", name: "小说", deleted: false }] as never;
      },
      async prepareSession() {
        return { workspacePath, additionalDirectories: [], projectId: "p1" } as never;
      },
    },
    tasks: {
      async getTaskMeta(params) {
        return tasks.find((entry) => entry.taskId === params.taskId) ?? null;
      },
      async createTask() {
        return { taskId: "sess_new", workspacePath };
      },
      async sendPrompt() {},
      async stopGeneration() {},
      async renameTask() {},
      async setTaskPinned() {},
      async archiveTask() {},
      async unarchiveTask() {},
    },
    agent: {
      async readSessionMessages() {
        return [{ id: "m1", role: "user", text: "你好" }];
      },
    },
    navigation: bridge,
  });
  let generationFence = 0;
  let staleOnBind = false;
  const responses: unknown[] = [];
  const requests = createAppControlRequestHandler({
    client: {
      async respond(_id, result) {
        responses.push(result);
      },
      async respondError(_id, error) {
        responses.push(error);
      },
    },
    service: () => service,
    bind: async ({ callerSessionId, callId, turnId, signal }) => {
      const fence = generationFence;
      // 模拟连接在 bind 之后、真正导航之前被替换：binding.assertCurrent 必须失效。
      if (staleOnBind) generationFence += 1;
      return {
        workspacePath,
        callerSessionId,
        callId,
        ...(turnId ? { turnId } : {}),
        uiTarget: "window:7",
        sourceServerId: "local",
        connectionId: `conn-${fence}`,
        signal,
        assertCurrent() {
          if (fence !== generationFence) throw new Error("connection generation changed");
          if (signal.aborted) throw new Error("connection aborted");
        },
      };
    },
    onResponseError: () => undefined,
  });
  const call = async (id: number, method: string, input: unknown, callId = `call-${id}`) => {
    requests.handle({
      id,
      method,
      params: { callerSessionId: "sess_a", callId, input },
    });
    for (let attempt = 0; attempt < 50 && responses.length < id; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return responses[id - 1];
  };
  const openDirect = async (sessionId: string, uiTarget: string) => {
    const context = await service.bind({
      workspacePath,
      callerSessionId: "sess_a",
      callId: "direct-call",
      uiTarget,
      sourceServerId: "local",
      connectionId: "direct",
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    return service.control.openSession(context, { sessionId });
  };
  return {
    service,
    openDirect,
    calls: { call, responses, navigate, rendererMessages },
    markStaleOnBind: () => {
      staleOnBind = true;
    },
    unregisterRenderer: () => sendFromRenderer({ type: "unregister", generation }),
  };
}

describe("app control navigation loopback", () => {
  it("反向 RPC 的 list/read/send/openSession 走生产服务并到达 Root 公开动作", async () => {
    const loop = createLoopback();
    const listed = (await loop.calls.call(1, "appControl/listSessions", {})) as {
      ok: boolean;
      result?: { sessions: unknown[] };
    };
    expect(listed.ok).toBe(true);
    expect(listed.result?.sessions).toHaveLength(2);

    const read = (await loop.calls.call(2, "appControl/readSession", {
      sessionId: "sess_a",
      view: "messages",
    })) as { ok: boolean; result?: { view: string } };
    expect(read.ok).toBe(true);
    expect(read.result?.view).toBe("messages");

    const sent = (await loop.calls.call(3, "appControl/sendToSession", {
      sessionId: "sess_a",
      prompt: "继续",
      requestId: "req-1",
    })) as { ok: boolean };
    expect(sent.ok).toBe(true);

    const opened = (await loop.calls.call(4, "appControl/openSession", {
      sessionId: "sess_b",
    })) as {
      ok: boolean;
      result?: { status: string; uiTarget?: string };
    };
    expect(opened.ok).toBe(true);
    expect(opened.result).toEqual({ status: "opened", uiTarget: "window:7" });
    expect(loop.calls.navigate).toEqual([{ path: workspacePath, taskId: "sess_b" }]);
  });

  it("renderer 未登记/generation 失效/显式外部窗口时 openSession 明确 unavailable", async () => {
    const loop = createLoopback();
    loop.unregisterRenderer();
    const opened = (await loop.calls.call(1, "appControl/openSession", {
      sessionId: "sess_b",
    })) as {
      ok: boolean;
      result: { status: string; reason?: string };
    };
    expect(opened.ok).toBe(true);
    expect(opened.result).toMatchObject({ status: "unavailable", reason: "renderer-unavailable" });
    expect(loop.calls.navigate).toEqual([]);

    // 显式外部窗口目标没有注册到 Main，不回落到当前窗口。
    const foreign = await loop.openDirect("sess_b", "window:999");
    expect(foreign).toMatchObject({ status: "unavailable", reason: "ui-target-unavailable" });
    expect(loop.calls.navigate).toEqual([]);
  });

  it("连接代际变化后不再接受旧绑定发起的导航", async () => {
    const loop = createLoopback();
    loop.markStaleOnBind();
    const opened = (await loop.calls.call(1, "appControl/openSession", {
      sessionId: "sess_b",
    })) as {
      ok: boolean;
      result: { status: string; reason?: string };
    };
    // 连接代际变化后 Host 在派发前复验失败：请求被拒绝，且不会产生导航副作用。
    expect(opened).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(loop.calls.navigate).toEqual([]);
  });

  it("跨 Host / 未知调用方根在绑定阶段即 forbidden，不触发导航或写 owner", async () => {
    const loop = createLoopback();
    const responses: unknown[] = [];
    const requests = createAppControlRequestHandler({
      client: {
        async respond(_id, result) {
          responses.push(result);
        },
        async respondError(_id, error) {
          responses.push(error);
        },
      },
      service: () => loop.service,
      bind: async ({ callerSessionId, callId, signal }) => ({
        workspacePath,
        callerSessionId,
        callId,
        sourceServerId: "remote",
        connectionId: "foreign",
        signal,
        assertCurrent() {},
      }),
      onResponseError: () => undefined,
    });
    requests.handle({
      id: 1,
      method: "appControl/openSession",
      params: { callerSessionId: "sess_forged", callId: "c1", input: { sessionId: "sess_b" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(responses[0]).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(loop.calls.navigate).toEqual([]);
  });
});
