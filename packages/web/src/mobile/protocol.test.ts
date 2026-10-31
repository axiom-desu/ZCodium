/// <reference types="node" />
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import {
  encodeWebRemoteControlRpcFrames,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcReplayBuffer,
  type WebRemoteControlAppPayload,
  type ZCodeStreamEvent,
} from "@zcode/shared";
import { MobileRemoteControlClient } from "./protocol.js";
import { TaskConversationLifecycle } from "./taskConversationLifecycle.js";
import { conversationReducer, initialConversationState } from "./conversationReducer.js";

// 与真实 Channel RPC 公共序列化格式一致；不 mock ChannelClient/RemoteServiceAccess。
const PROMISE = 100;
const EVENT_LISTEN = 102;
const EVENT_DISPOSE = 103;
const INITIALIZE = 200;
const SUCCESS = 201;
const EVENT_FIRE = 204;

type BridgeOpen = Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-bridge-open" }>;

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: WebRemoteControlAppPayload[] = [];
  sentWire: Record<string, unknown>[] = [];
  private listeners = new Map<
    string,
    ((event: { data?: string; code?: number; reason?: string }) => void)[]
  >();
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(
    type: string,
    listener: (event: { data?: string; code?: number; reason?: string }) => void,
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  fire(type: string, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open");
  }
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.sentWire.push(frame);
    if (frame.type === "data") this.sent.push(frame.payload);
  }
  receive(payload: WebRemoteControlAppPayload) {
    this.wire({ type: "data", payload });
  }
  wire(frame: unknown) {
    this.fire("message", { data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "test" });
  }
  opens(): BridgeOpen[] {
    return this.sent.filter((p): p is BridgeOpen => p.zcode_type === "workspace-bridge-open");
  }
  ready(open: BridgeOpen) {
    this.receive({
      zcode_type: "workspace-bridge-ready",
      requestId: open.requestId,
      bridgeSessionId: open.bridgeSessionId,
      bridge: {
        bridgeSessionId: open.bridgeSessionId,
        workspaceKey: open.workspaceKey,
        workspacePath: "/workspace",
        kind: "local",
        entryKind: "task",
      },
    });
  }
}

function rpcBytes(header: number[], body?: unknown) {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return { __zcodeBytes: btoa(String.fromCharCode(...writer.buffer.buffer)) };
}

function host(socket: FakeWebSocket, streamId: string) {
  let seq = 0;
  return {
    send(header: number[], body?: unknown) {
      seq += 1;
      const frames = encodeWebRemoteControlRpcFrames(rpcBytes(header, body), { streamId, seq });
      for (const frame of frames) socket.receive({ zcode_type: "rpc-frame", frame });
      return frames;
    },
  };
}

function requests(socket: FakeWebSocket, streamId: string) {
  const assembler = new WebRemoteControlRpcAssembler({ streamId });
  const output: { seq: number; header: (number | string)[]; body: unknown }[] = [];
  for (const payload of socket.sent) {
    if (payload.zcode_type !== "rpc-frame" || payload.frame.streamId !== streamId) continue;
    if (payload.frame.kind === "ack") continue;
    for (const event of assembler.push(payload.frame)) {
      if (event.kind !== "message") continue;
      const value = event.message as { __zcodeBytes: string };
      const reader = new BufferReader(
        VSBuffer.wrap(Uint8Array.from(atob(value.__zcodeBytes), (char) => char.charCodeAt(0))),
      );
      output.push({ seq: event.seq, header: deserialize(reader), body: deserialize(reader) });
    }
  }
  return output;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
const clients: MobileRemoteControlClient[] = [];
function client(onPayload = vi.fn<(payload: WebRemoteControlAppPayload) => void>()) {
  const onStateChange = vi.fn();
  const c = new MobileRemoteControlClient(
    { deviceSid: "test-device", passHash: "test-hash", wsUrl: "ws://localhost/ws" },
    {
      onPayload,
      onStateChange,
    },
  );
  clients.push(c);
  c.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.wire({ type: "auth_ack", pair_status: "matched" });
  return { c, socket, onPayload, onStateChange };
}
const access = { workspaceKey: "A", taskId: "task-a", workspacePath: "/workspace" };
const chunk: ZCodeStreamEvent = {
  type: "agent_message_chunk",
  taskId: access.taskId,
  traceId: "trace",
  messageId: "m",
  inputId: "input",
  content: "ha",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
});
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MobileRemoteControlClient fake WebSocket", () => {
  it("无 crypto.subtle 时仍使用 UTF-8 HMAC-SHA256（含长 key）并与 Node 一致", async () => {
    vi.stubGlobal("crypto", {});
    const params = {
      deviceSid: "sid-手机",
      passHash: "长密钥🌏".repeat(40),
      wsUrl: "ws://localhost/ws",
    };
    const c = new MobileRemoteControlClient(params, {
      onPayload: vi.fn(),
      onStateChange: vi.fn(),
    });
    clients.push(c);
    c.connect();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    const nonce = "nonce-雪🌙";
    socket.wire({ type: "auth_challenge", nonce });
    await flush();
    const auth = socket.sentWire.find((frame) => frame.type === "auth_response");
    const expected = createHmac("sha256", params.passHash)
      .update(`${nonce}|mobile|${params.deviceSid}`, "utf8")
      .digest("base64url");
    expect(auth?.proof).toBe(expected);
  });

  it.each(["AUTH_FAILED", "KICKED", "WRONG_PARAM"])(
    "%s 错误终止并保留状态，不因 close/重试/重复 connect 复活",
    async (code) => {
      const { c, socket, onStateChange } = client();
      socket.wire({ type: "error", code, message: "stable failure" });
      expect(c.getState()).toBe("error");
      socket.close();
      await vi.advanceTimersByTimeAsync(60_000);
      c.retryNow();
      c.connect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(c.getState()).toBe("error");
      expect(onStateChange).toHaveBeenLastCalledWith("error", { reason: code });
    },
  );

  it.each([
    [4001, "拒绝"],
    [4002, "互踢"],
    [4003, "配对过期"],
  ])("关闭码 %i 是终止错误（原因：%s）", async (code, reason) => {
    const { c, socket, onStateChange } = client();
    socket.fire("close", { code, reason });
    await vi.advanceTimersByTimeAsync(60_000);
    c.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(c.getState()).toBe("error");
    expect(onStateChange).toHaveBeenLastCalledWith("error", {
      reason: code === 4002 ? "KICKED" : code === 4003 ? "AUTH_FAILED" : "CONNECTION_REJECTED",
      closeCode: code,
    });
  });

  it("终止释放在途 bridge 请求，迟到帧不复活且后续请求立即拒绝", async () => {
    const { c, socket } = client();
    const ready = c
      .ensureWorkspaceBridge({ workspaceKey: "A" })
      .catch((error: Error) => error.message);
    await flush();
    const open = socket.opens()[0]!;
    socket.wire({ type: "error", code: "KICKED", message: "proof=should-not-leak" });
    expect(await ready).toBe("KICKED");
    socket.ready(open);
    socket.wire({ type: "auth_ack", pair_status: "matched" });
    socket.fire("error");
    expect(c.getState()).toBe("error");
    await expect(
      c.request({ zcode_type: "bootstrap-request", requestId: "after-stop" }),
    ).rejects.toThrow("mobile connection terminated: KICKED");
  });

  it("未经 auth_ack 的 open 不清退避，pair_status_ack 不清零，auth_ack 才清零", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const c = new MobileRemoteControlClient(
      { deviceSid: "sid", passHash: "hash", wsUrl: "ws://localhost/ws" },
      { onPayload: vi.fn(), onStateChange: vi.fn() },
    );
    clients.push(c);
    c.connect();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.wire({ type: "pair_status_ack", pair_status: "waiting" });
    second.close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const third = FakeWebSocket.instances[2]!;
    third.open();
    third.wire({ type: "auth_ack", pair_status: "matched" });
    third.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("Initialize 可先于 ready，replayable 订阅使用真实 RPC，重复物理 seq 只交付一次", async () => {
    const { c, socket } = client();
    let state = conversationReducer(initialConversationState, {
      type: "beginScope",
      scope: access,
    });
    state = conversationReducer(state, { type: "applySnapshot", scope: access, messages: [] });
    const listener = vi.fn((event: ZCodeStreamEvent) => {
      state = conversationReducer(state, { type: "streamEvent", scope: access, event });
    });
    const subscription = c.subscribeTaskStream(access, listener);
    await flush();
    const open = socket.opens()[0]!;
    const desktop = host(socket, open.bridgeSessionId);
    desktop.send([INITIALIZE]);
    socket.ready(open);
    await subscription;
    const listen = requests(socket, open.bridgeSessionId)[0]!;
    expect(listen.seq).toBe(1);
    expect(listen.header[0]).toBe(EVENT_LISTEN);
    expect(listen.header[3]).toBe("onDynamicTaskEvent");
    expect(listen.body).toMatchObject({ deliveryKind: "replayable", taskId: access.taskId });
    const frames = desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    for (const frame of frames) socket.receive({ zcode_type: "rpc-frame", frame });
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(state.messages[0]?.text).toBe("haha");
    (await subscription).dispose();
  });

  it("degraded 作废旧 RPC，重新 open → Initialize → EventListen → read，不走旧 ready 快路径", async () => {
    let lifecycle!: TaskConversationLifecycle;
    const { c, socket } = client(
      vi.fn((payload) => {
        if (payload.zcode_type === "bridge-degraded") lifecycle.recoverBridge();
      }),
    );
    const onError = vi.fn();
    let state = initialConversationState;
    lifecycle = new TaskConversationLifecycle(access, {
      subscribe: (listener) => c.subscribeTaskStream(access, listener),
      read: () => c.readTaskSnapshot(access),
      dispatch: (action) => {
        state = conversationReducer(state, action);
      },
      onError,
    });
    lifecycle.start();
    await flush();
    const first = socket.opens()[0]!;
    const oldHost = host(socket, first.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(first);
    await flush();
    const firstRequests = requests(socket, first.bridgeSessionId);
    expect(firstRequests.map((r) => r.header[3])).toEqual([
      "onDynamicTaskEvent",
      "readSessionMessages",
    ]);
    socket.receive({
      zcode_type: "bridge-degraded",
      bridgeSessionId: first.bridgeSessionId,
      reason: "rpc-transport-fault",
    });
    await flush();
    expect(socket.opens()).toHaveLength(2);
    expect(state.awaitingSnapshot).toBe(true);
    const second = socket.opens()[1]!;
    // 旧帧不许 Initialize 新 ChannelClient；无新 Initialize 时不发订阅/快照请求。
    oldHost.send([INITIALIZE]);
    socket.ready(second);
    await flush();
    expect(requests(socket, second.bridgeSessionId)).toEqual([]);
    const newHost = host(socket, second.bridgeSessionId);
    newHost.send([INITIALIZE]);
    await flush();
    const secondRequests = requests(socket, second.bridgeSessionId);
    expect(secondRequests.map((r) => r.header[3])).toEqual([
      "onDynamicTaskEvent",
      "readSessionMessages",
    ]);
    expect(secondRequests[0]?.seq).toBe(1);
    expect(secondRequests[0]?.body).toMatchObject({ deliveryKind: "replayable" });
    const read = secondRequests.find((r) => r.header[0] === PROMISE)!;
    oldHost.send([SUCCESS, Number(read.header[1])], [{ invalid: "old" }]);
    newHost.send([SUCCESS, Number(read.header[1])], []);
    await flush();
    expect(state.awaitingSnapshot).toBe(false);
    expect(state.messages).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("deferred A/B/A 的实际 wire open 顺序串行，新桥序号重置且旧帧不进新 client", async () => {
    const { c, socket } = client();
    const readyA = c.ensureWorkspaceBridge({ workspaceKey: "A" });
    await flush();
    const a1 = socket.opens()[0]!;
    const oldHost = host(socket, a1.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(a1);
    await readyA;
    const oldRead = c.readTaskSnapshot(access).catch((error: Error) => error.message);
    await flush();
    const readyB = c
      .ensureWorkspaceBridge({ workspaceKey: "B" })
      .catch((error: Error) => error.message);
    await flush();
    const b = socket.opens()[1]!;
    const readyA2 = c.ensureWorkspaceBridge({ workspaceKey: "A" });
    await flush();
    expect(socket.opens().map((o) => o.workspaceKey)).toEqual(["A", "B"]);
    const lateB = host(socket, b.bridgeSessionId);
    // Host attach 异步：生产 ready 不保证 Initialize 已发送，不能预先见过 B 身份。
    socket.ready(b);
    await flush();
    expect(await readyB).toBe("workspace bridge superseded");
    expect(await oldRead).toBe("mobile bridge invalidated");
    expect(socket.opens().map((o) => o.workspaceKey)).toEqual(["A", "B", "A"]);
    const a2 = socket.opens()[2]!;
    lateB.send([INITIALIZE]);
    oldHost.send([INITIALIZE]);
    const newHost = host(socket, a2.bridgeSessionId);
    socket.ready(a2);
    await readyA2;
    const freshRead = c.readTaskSnapshot(access);
    const settled = vi.fn();
    void freshRead.then(settled);
    await flush();
    expect(requests(socket, a2.bridgeSessionId)).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
    newHost.send([INITIALIZE]);
    await flush();
    const read = requests(socket, a2.bridgeSessionId)[0]!;
    expect(read.seq).toBe(1);
    expect(read.header[3]).toBe("readSessionMessages");
    oldHost.send([SUCCESS, Number(read.header[1])], ["stale-a"]);
    lateB.send([SUCCESS, Number(read.header[1])], ["stale-b"]);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    newHost.send([SUCCESS, Number(read.header[1])], []);
    await flush();
    expect(settled).toHaveBeenCalledWith([]);
    expect(await freshRead).toEqual([]);
  });

  it("手机按 open 身份过滤 ack/flow/分片，双向 ack 不串序号空间", async () => {
    const { c, socket, onPayload } = client();
    const listener = vi.fn();
    const subscription = c.subscribeTaskStream(access, listener);
    await flush();
    const open = socket.opens()[0]!;
    socket.ready(open);
    const stale = encodeWebRemoteControlRpcFrames(
      { stale: "x".repeat(1_100_000) },
      {
        streamId: "unknown-retired-bridge",
        seq: 1,
      },
    );
    expect(stale.length).toBeGreaterThan(1);
    for (const frame of [...stale, ...stale]) socket.receive({ zcode_type: "rpc-frame", frame });
    const acknowledge = vi.spyOn(WebRemoteControlRpcReplayBuffer.prototype, "acknowledge");
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: "unknown-retired-bridge", kind: "ack", seq: 100, ackSeq: 100 },
    });
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: "unknown-retired-bridge", kind: "flow", seq: 1, flow: "saturated" },
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(onPayload).not.toHaveBeenCalled();
    const desktop = host(socket, open.bridgeSessionId);
    desktop.send([INITIALIZE]);
    const handle = await subscription;
    const listen = requests(socket, open.bridgeSessionId)[0]!;
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    // 手机出站只有 EventListen(seq=1)，桌面入站已到 EventFire(seq=3)。
    socket.receive({
      zcode_type: "rpc-frame",
      frame: { streamId: open.bridgeSessionId, kind: "ack", seq: 1, ackSeq: 1 },
    });
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(
      socket.sent.filter((p) => p.zcode_type === "rpc-frame" && p.frame.kind === "ack"),
    ).toContainEqual({
      zcode_type: "rpc-frame",
      frame: { streamId: open.bridgeSessionId, kind: "ack", seq: 3, ackSeq: 3 },
    });
    // 对端 ack 不可推进本端入站水位；下一条 EventFire(seq=4) 仍正常交付。
    desktop.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    expect(listener).toHaveBeenCalledTimes(3);
    handle.dispose();
    expect(requests(socket, open.bridgeSessionId).at(-1)?.header[0]).toBe(EVENT_DISPOSE);
  });

  it("事件回调同步切桥后，旧消息不能给新桥排 ack", async () => {
    const { c, socket } = client();
    let switching!: Promise<void>;
    const subscription = c.subscribeTaskStream(access, () => {
      switching = c.ensureWorkspaceBridge({ workspaceKey: "B" });
    });
    await flush();
    const first = socket.opens()[0]!;
    const oldHost = host(socket, first.bridgeSessionId);
    oldHost.send([INITIALIZE]);
    socket.ready(first);
    await subscription;
    const listen = requests(socket, first.bridgeSessionId)[0]!;
    oldHost.send([EVENT_FIRE, Number(listen.header[1])], chunk);
    await flush();
    const next = socket.opens()[1]!;
    socket.ready(next);
    await switching;
    await vi.advanceTimersByTimeAsync(10);
    expect(
      socket.sent.filter(
        (payload) =>
          payload.zcode_type === "rpc-frame" &&
          payload.frame.streamId === next.bridgeSessionId &&
          payload.frame.kind === "ack",
      ),
    ).toEqual([]);
  });

  it("INTERNAL 保持临时错误并在断线后自动重试", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { c, socket } = client();
    socket.wire({ type: "error", code: "INTERNAL", message: "temporary" });
    socket.fire("close", { code: 4001, reason: "INTERNAL" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances[1]!;
    next.open();
    // 新一轮的 4001 不能沿用上一轮 INTERNAL 语义。
    next.fire("close", { code: 4001, reason: "AUTH_FAILED" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(c.getState()).toBe("error");
  });

  it("旧 socket 回调不改新连接状态/信封/RPC", async () => {
    const { c, socket, onPayload } = client();
    socket.close();
    await vi.advanceTimersByTimeAsync(2000);
    const next = FakeWebSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    next.open();
    next.wire({ type: "auth_ack", pair_status: "matched" });
    socket.wire({ type: "pair_status_ack", pair_status: "waiting" });
    socket.receive({ zcode_type: "app-error", reason: "unexpectedError", error: "stale" });
    await flush();
    expect(c.getState()).toBe("paired");
    expect(onPayload).not.toHaveBeenCalled();
  });
});

const directoryRoot = {
  rootIdentity: { hostId: "local", projectId: "p", rootPath: "/workspace" },
  projectName: "P",
  enabled: true,
  attachmentGeneration: 1,
  runtimeIdentity: { identity: "actor", generation: 1, workspaceKey: "/workspace" },
};
const directoryDisabledRoot = {
  ...directoryRoot,
  rootIdentity: { ...directoryRoot.rootIdentity, rootPath: "/unbound" },
  enabled: false,
  runtimeIdentity: undefined,
};

describe("MobileRemoteControlClient 项目目录 capability/epoch", () => {
  it("旧 peer 未宣告 capability 时不建目录代理、不发目录 RPC", async () => {
    const { c, socket } = client();
    const pending = c.readProjectDirectory("A");
    await flush();
    const open = socket.opens()[0]!;
    const desktop = host(socket, open.bridgeSessionId);
    desktop.send([INITIALIZE]);
    socket.ready(open);
    expect(await pending).toBeNull();
    expect(requests(socket, open.bridgeSessionId)).toEqual([]);
  });

  it("只读投影经真实 RPC；伪造/禁用 root 与换代后的创建都被拒绝", async () => {
    const { c, socket } = client();
    const pending = c.readProjectDirectory("A");
    await flush();
    const first = socket.opens()[0]!;
    const desktop = host(socket, first.bridgeSessionId);
    desktop.send([INITIALIZE], { mobileProjectDirectory: true });
    socket.ready(first);
    await flush();
    const read = requests(socket, first.bridgeSessionId).find(
      (request) => request.header[2] === "mobile-project-directory",
    )!;
    expect(read.header[3]).toBe("readProjects");
    desktop.send([SUCCESS, Number(read.header[1])], [directoryRoot, directoryDisabledRoot]);
    const roots = (await pending)!;
    expect(roots).toEqual([directoryRoot, directoryDisabledRoot]);
    // 未由本入口读取（或参数被改写）的 root 不能创建。
    await expect(c.createProjectTask({ ...directoryRoot } as never)).rejects.toThrow(
      "project.stale-attachment",
    );
    await expect(c.createProjectTask(roots[1]!)).rejects.toThrow("project.stale-attachment");
    const created = c.createProjectTask(roots[0]!);
    await flush();
    const create = requests(socket, first.bridgeSessionId).find(
      (request) => request.header[3] === "createTask",
    )!;
    expect(create.header[2]).toBe("mobile-project-directory");
    expect(create.body).toEqual([directoryRoot]);
    desktop.send([SUCCESS, Number(create.header[1])], { taskId: "t1" });
    await expect(created).resolves.toEqual({ taskId: "t1" });
    // 桥换代（切 workspace）后旧 root 不得再投递。
    const switching = c.ensureWorkspaceBridge({ workspaceKey: "B" });
    await flush();
    const second = socket.opens()[1]!;
    host(socket, second.bridgeSessionId).send([INITIALIZE], { mobileProjectDirectory: true });
    socket.ready(second);
    await switching;
    await expect(c.createProjectTask(roots[0]!)).rejects.toThrow("project.stale-attachment");
    expect(
      requests(socket, second.bridgeSessionId).filter(
        (request) => request.header[3] === "createTask",
      ),
    ).toEqual([]);
  });

  it("迟到的目录读取不能覆盖新入口，也不导航", async () => {
    const { c, socket } = client();
    const readyA = c.readProjectDirectory("A");
    await flush();
    const a = socket.opens()[0]!;
    const desktop = host(socket, a.bridgeSessionId);
    desktop.send([INITIALIZE], { mobileProjectDirectory: true });
    socket.ready(a);
    await flush();
    const firstRead = requests(socket, a.bridgeSessionId).find(
      (request) => request.header[3] === "readProjects",
    )!;
    desktop.send([SUCCESS, Number(firstRead.header[1])], [directoryRoot]);
    expect(await readyA).toEqual([directoryRoot]);
    const late = c.readProjectDirectory("A");
    await flush();
    const secondRead = requests(socket, a.bridgeSessionId).filter(
      (request) => request.header[3] === "readProjects",
    )[1]!;
    const switching = c.ensureWorkspaceBridge({ workspaceKey: "B" });
    await flush();
    const b = socket.opens()[1]!;
    host(socket, b.bridgeSessionId).send([INITIALIZE], { mobileProjectDirectory: true });
    socket.ready(b);
    await switching;
    desktop.send([SUCCESS, Number(secondRead.header[1])], [directoryDisabledRoot]);
    await expect(late).rejects.toThrow(/invalidated|superseded/u);
    await expect(c.createProjectTask(directoryRoot as never)).rejects.toThrow(
      "project.stale-attachment",
    );
  });
});
