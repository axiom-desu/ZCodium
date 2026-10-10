/**
 * `surface.js` 单测：ZCode 14 工具名 → cua-driver / 兼容层的映射与目标解析。
 *
 * 契约见 `.agents/specs/computer-use-capabilities.md` §2、§3。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createCuaDriverRuntime } from "../index.js";
import { createSurfaceLayer, parseKeyChord, ZCODE_SURFACE_TOOLS } from "../surface.js";

const ELEMENTS = [
  {
    element_index: 202,
    element_token: "s1:202",
    label: "5",
    frame: { x: 282, y: 517, w: 60, h: 44 },
  },
];

const projectDriverResult = (raw) => ({
  content: raw?.text ? [{ type: "text", text: raw.text }] : [],
  isError: false,
  _meta: { driverResult: raw?.structuredJson },
});
const projectDriverError = (tool, error) => ({
  content: [{ type: "text", text: String(error?.message ?? error) }],
  isError: true,
  structuredContent: { tool, code: error?.code },
});

function windowStateHandler() {
  return () => ({
    text: "tree",
    structuredJson: JSON.stringify({
      snapshot_id: "s1",
      elements: ELEMENTS,
      app_name: "Calculator",
    }),
    images: [],
    isError: false,
  });
}

function makeSurface(handlers = {}, compat = null) {
  const calls = [];
  const callDriver = async (name, args) => {
    calls.push({ name, args });
    const handler = handlers[name];
    return handler
      ? handler(args)
      : {
          text: "",
          structuredJson: "{}",
          images: [],
          isError: false,
          degraded: false,
          rawJson: "{}",
        };
  };
  const surface = createSurfaceLayer({
    callDriver,
    compat,
    compatApplies: Boolean(compat),
    projectDriverResult,
    projectDriverError,
  });
  return { surface, calls };
}

function makeCompat() {
  const calls = [];
  return {
    calls,
    applies: true,
    async execute(input) {
      calls.push(input);
      return {
        content: [{ type: "text", text: "compat ok" }],
        isError: false,
        _meta: { compat: true, actionSent: true },
      };
    },
  };
}

test("14 个工具名齐全", () => {
  assert.equal(ZCODE_SURFACE_TOOLS.length, 14);
  assert.ok(ZCODE_SURFACE_TOOLS.includes("left_click"));
  assert.ok(ZCODE_SURFACE_TOOLS.includes("get_app_state"));
});

test("parseKeyChord 拆分修饰键与末键", () => {
  assert.deepEqual(parseKeyChord("ctrl+shift+t"), { modifiers: ["ctrl", "shift"], key: "t" });
  assert.deepEqual(parseKeyChord("enter"), { modifiers: [], key: "enter" });
});

test("list_apps / list_windows 读 structuredJson", async () => {
  const { surface } = makeSurface({
    list_apps: () => ({
      structuredJson: JSON.stringify({ apps: [{ name: "Calculator", pid: 100 }] }),
      text: "human list",
      isError: false,
    }),
    list_windows: () => ({
      structuredJson: JSON.stringify({ windows: [{ window_id: 58, title: "Calculator" }] }),
      isError: false,
    }),
  });
  assert.deepEqual(
    JSON.parse((await surface.execute({ toolName: "list_apps", arguments: {} })).content[0].text),
    [{ name: "Calculator", pid: 100 }],
  );
  assert.deepEqual(
    JSON.parse(
      (await surface.execute({ toolName: "list_windows", arguments: { app_ref: { pid: 100 } } }))
        .content[0].text,
    ),
    [{ window_id: 58, title: "Calculator" }],
  );
});

test("get_app_state 记录快照并投影 state_id/elements", async () => {
  const { surface } = makeSurface({ get_window_state: windowStateHandler() });
  const result = await surface.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 100 }, window_id: 58 },
  });
  assert.equal(result.structuredContent.state_id, "s1");
  assert.equal(result.structuredContent.elements.length, 1);
  assert.equal(result.structuredContent.app.pid, 100);
});

test("观测 diffing：首次全量，未变化则空 diff，disable_diffing 强制全量", async () => {
  let version = 0;
  const callDriver = async (name) => {
    if (name === "get_window_state") {
      const elements = [
        {
          element_index: 1,
          element_token: "s:1",
          role: "button",
          label: version === 0 ? "A" : "B",
          frame: { x: 0, y: 0, w: 1, h: 1 },
        },
      ];
      return {
        text: "t",
        structuredJson: JSON.stringify({ snapshot_id: `s${version}`, elements }),
        isError: false,
      };
    }
    return { text: "", structuredJson: "{}", isError: false };
  };
  const surface = createSurfaceLayer({
    callDriver,
    compat: null,
    compatApplies: false,
    projectDriverResult,
    projectDriverError,
  });
  const args = { app_ref: { pid: 1 }, window_id: 2 };
  const first = await surface.execute({ toolName: "get_app_state", arguments: args });
  assert.equal(first._meta.diff, false);
  assert.equal(first.structuredContent.elements.length, 1);
  const second = await surface.execute({ toolName: "get_app_state", arguments: args });
  assert.equal(second._meta.diff, true);
  assert.equal(second.structuredContent.elements.length, 0);
  version = 1;
  const third = await surface.execute({ toolName: "get_app_state", arguments: args });
  assert.equal(third._meta.diff, true);
  assert.equal(third.structuredContent.elements.length, 1);
  const full = await surface.execute({
    toolName: "get_app_state",
    arguments: { ...args, disable_diffing: true },
  });
  assert.equal(full._meta.diff, false);
  assert.equal(full.structuredContent.elements.length, 1);
});

test("tree_shown_to_model:false 不置 baseline，下一次仍全量", async () => {
  const callDriver = async (name) => {
    if (name === "get_window_state")
      return {
        text: "t",
        structuredJson: JSON.stringify({ snapshot_id: "s", elements: ELEMENTS }),
        isError: false,
      };
    return { text: "", structuredJson: "{}", isError: false };
  };
  const surface = createSurfaceLayer({
    callDriver,
    compat: null,
    compatApplies: false,
    projectDriverResult,
    projectDriverError,
  });
  const args = { app_ref: { pid: 1 }, window_id: 2 };
  const probe = await surface.execute({
    toolName: "get_app_state",
    arguments: { ...args, tree_shown_to_model: false },
  });
  assert.equal(probe._meta.diff, false);
  const next = await surface.execute({ toolName: "get_app_state", arguments: args });
  assert.equal(next._meta.diff, false);
  assert.equal(next.structuredContent.elements.length, ELEMENTS.length);
});

test("left_click 把 element index 传给兼容层（token 会被重新观测而失效）", async () => {
  const compat = makeCompat();
  const { surface } = makeSurface({ get_window_state: windowStateHandler() }, compat);
  await surface.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 100 }, window_id: 58 },
  });
  compat.calls.length = 0;
  const result = await surface.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 100 }, window_id: 58, target: 202 },
  });
  assert.equal(result.isError, false);
  assert.equal(compat.calls.length, 1);
  assert.equal(compat.calls[0].toolName, "click");
  assert.equal(compat.calls[0].arguments.element_index, 202);
  assert.equal(compat.calls[0].arguments.element_token, undefined);
});

test("无观测就动作 → STALE_STATE", async () => {
  const { surface } = makeSurface({}, makeCompat());
  const result = await surface.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 100 }, window_id: 58, target: 999 },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "STALE_STATE");
});

test("key 的 chord 走 hotkey，单键走 press_key", async () => {
  const compat = makeCompat();
  const { surface } = makeSurface({}, compat);
  await surface.execute({
    toolName: "key",
    arguments: { app_ref: { pid: 100 }, window_id: 58, text: "ctrl+shift+t" },
  });
  assert.equal(compat.calls.at(-1).toolName, "hotkey");
  assert.deepEqual(compat.calls.at(-1).arguments.keys, ["ctrl", "shift", "t"]);
  await surface.execute({
    toolName: "key",
    arguments: { app_ref: { pid: 100 }, window_id: 58, text: "enter" },
  });
  assert.equal(compat.calls.at(-1).toolName, "press_key");
  assert.equal(compat.calls.at(-1).arguments.key, "enter");
});

test("paste = clipboard_write(驱动) + hotkey(兼容层)", async () => {
  const compat = makeCompat();
  const { surface, calls } = makeSurface(
    { clipboard_write: () => ({ structuredJson: "{}", text: "ok", isError: false }) },
    compat,
  );
  await surface.execute({ toolName: "paste", arguments: { text: "hi" } });
  assert.ok(calls.some((call) => call.name === "clipboard_write" && call.args.text === "hi"));
  assert.equal(compat.calls.at(-1).toolName, "hotkey");
  assert.deepEqual(compat.calls.at(-1).arguments.keys, ["ctrl", "v"]);
});

test("select_text / perform_action → ACTION_UNAVAILABLE", async () => {
  const { surface } = makeSurface({}, makeCompat());
  for (const toolName of ["select_text", "perform_action"]) {
    const result = await surface.execute({ toolName, arguments: {} });
    assert.equal(result.isError, true, toolName);
    assert.equal(result.structuredContent.code, "ACTION_UNAVAILABLE", toolName);
  }
});

test("request_access 全批准", async () => {
  const { surface } = makeSurface({
    check_permissions: () => ({ structuredJson: "{}", text: "ok", isError: false }),
  });
  const result = await surface.execute({ toolName: "request_access", arguments: {} });
  assert.equal(result.structuredContent.granted, true);
});

test("后台不可用时自动前台重试（driver）", async () => {
  let clicks = 0;
  const calls = [];
  const callDriver = async (name, args) => {
    calls.push({ name, args });
    if (name === "get_window_state") {
      return {
        text: "t",
        structuredJson: JSON.stringify({ snapshot_id: "s1", elements: ELEMENTS }),
        isError: false,
      };
    }
    if (name === "click") {
      clicks += 1;
      return clicks === 1
        ? {
            isError: true,
            errorCode: "background_unavailable",
            text: "background delivery refused",
          }
        : { text: "clicked", isError: false };
    }
    return { text: "", structuredJson: "{}", isError: false };
  };
  const surface = createSurfaceLayer({
    callDriver,
    compat: null,
    compatApplies: false,
    projectDriverResult,
    projectDriverError,
  });
  await surface.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 100 }, window_id: 58 },
  });
  const result = await surface.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 100 }, window_id: 58, target: 202 },
  });
  assert.equal(result.isError, false);
  assert.equal(result._meta.foregroundFallback, true);
  assert.equal(result._meta.deliveryMode, "foreground");
  const clickCalls = calls.filter((call) => call.name === "click");
  assert.equal(clickCalls.length, 2);
  assert.equal(clickCalls[0].args.delivery_mode, undefined);
  assert.equal(clickCalls[1].args.delivery_mode, "foreground");
});

test("兼容层结果标记前台", async () => {
  const compat = makeCompat();
  const { surface } = makeSurface({ get_window_state: windowStateHandler() }, compat);
  await surface.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 100 }, window_id: 58 },
  });
  const result = await surface.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 100 }, window_id: 58, target: 202 },
  });
  assert.equal(result._meta.deliveryMode, "foreground");
});

test("冷启动未就绪自动重试，成功标 actionSent:true", async () => {
  let attempts = 0;
  const callDriver = async (name) => {
    if (name === "get_window_state")
      return {
        text: "t",
        structuredJson: JSON.stringify({ snapshot_id: "s1", elements: ELEMENTS }),
        isError: false,
      };
    if (name === "click") {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("runtime not ready");
        error.code = "CUA_NOT_READY";
        throw error;
      }
      return { text: "clicked", isError: false };
    }
    return { text: "", structuredJson: "{}", isError: false };
  };
  const surface = createSurfaceLayer({
    callDriver,
    compat: null,
    compatApplies: false,
    projectDriverResult,
    projectDriverError,
    sleep: async () => {},
  });
  await surface.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 100 }, window_id: 58 },
  });
  const result = await surface.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 100 }, window_id: 58, target: 202 },
  });
  assert.equal(result.isError, false);
  assert.equal(result._meta.actionSent, true);
  assert.equal(attempts, 2);
});

test("动作失败标 actionSent:false；不确定投递标 true+possiblySent", async () => {
  const errorDriver = async (name) => {
    if (name === "get_window_state")
      return {
        text: "t",
        structuredJson: JSON.stringify({ snapshot_id: "s1", elements: ELEMENTS }),
        isError: false,
      };
    if (name === "click") {
      const error = new Error("bad target");
      error.errorCode = "invalid_request";
      throw error;
    }
    return { text: "", structuredJson: "{}", isError: false };
  };
  const failed = createSurfaceLayer({
    callDriver: errorDriver,
    compat: null,
    compatApplies: false,
    projectDriverResult,
    projectDriverError,
    sleep: async () => {},
  });
  await failed.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 100 }, window_id: 58 },
  });
  const failedResult = await failed.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 100 }, window_id: 58, target: 202 },
  });
  assert.equal(failedResult.isError, true);
  assert.equal(failedResult._meta.actionSent, false);

  const sentDriver = async (name) => {
    if (name === "get_window_state")
      return {
        text: "t",
        structuredJson: JSON.stringify({ snapshot_id: "s1", elements: ELEMENTS }),
        isError: false,
      };
    if (name === "click")
      return {
        isError: true,
        text: "possibly sent",
        rawJson: JSON.stringify({ dispatch_status: "possibly_sent" }),
        structuredJson: "{}",
      };
    return { text: "", structuredJson: "{}", isError: false };
  };
  const sent = createSurfaceLayer({
    callDriver: sentDriver,
    compat: null,
    compatApplies: false,
    projectDriverResult,
    projectDriverError,
    sleep: async () => {},
  });
  await sent.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 100 }, window_id: 58 },
  });
  const sentResult = await sent.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 100 }, window_id: 58, target: 202 },
  });
  assert.equal(sentResult._meta.actionSent, true);
  assert.equal(sentResult._meta.possiblySent, true);
});

test("runtime 识别 ZCode 工具名并走 surface", async () => {
  const client = {
    async callTool(name) {
      if (name === "get_window_state")
        return {
          text: "t",
          structuredJson: JSON.stringify({ snapshot_id: "s9", elements: [] }),
          isError: false,
        };
      return { text: "", structuredJson: "{}", images: [], isError: false };
    },
  };
  const runtime = createCuaDriverRuntime(client, {});
  const result = await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 1 }, window_id: 2 },
    context: {},
  });
  assert.equal(result.structuredContent.state_id, "s9");
});
