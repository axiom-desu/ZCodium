/**
 * `compatible/executor.js` 单测：工具 → backend 的翻译与失败语义。
 *
 * 覆盖 `.agents/specs/computer-use-wayland-input.md` §8.1：输入类工具的
 * 元素→屏幕定位、hotkey/press_key、type_text 分级，以及不支持项的 ACTION_UNAVAILABLE。
 * backend 与 cua-driver client 都用假件。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createCompatExecutor } from "../compatible/executor.js";

const ELEMENTS = [
  {
    element_index: 202,
    element_token: "s1:202",
    role: "push button",
    label: "5",
    frame: { x: 282, y: 517, w: 60, h: 44 },
  },
];

function makeBackend({ windows, monitors } = {}) {
  const calls = [];
  return {
    calls,
    async listWindows() {
      calls.push({ method: "listWindows" });
      return (
        windows ?? [
          {
            id: 31,
            pid: 100,
            title: "Calculator",
            x: 174,
            y: 104,
            w: 1360,
            h: 1084,
            buffer_x: 122,
            buffer_y: 58,
          },
        ]
      );
    },
    async monitors() {
      calls.push({ method: "monitors" });
      return monitors ?? [{ x: 0, y: 0, w: 1600, h: 1000, scale: 2, primary: true }];
    },
    async activate(id) {
      calls.push({ method: "activate", id });
      return true;
    },
    async click(x, y, button) {
      calls.push({ method: "click", x, y, button });
    },
    async moveTo(x, y) {
      calls.push({ method: "moveTo", x, y });
    },
    async scroll(direction, amount) {
      calls.push({ method: "scroll", direction, amount });
    },
    async drag(from, to, opts) {
      calls.push({ method: "drag", from, to, opts });
    },
    async hotkey(mods, key) {
      calls.push({ method: "hotkey", mods, key });
    },
    async pressKey(key) {
      calls.push({ method: "pressKey", key });
    },
    async typeAscii(text) {
      calls.push({ method: "typeAscii", text });
    },
    async typeUnicode(text) {
      calls.push({ method: "typeUnicode", text });
    },
    async dispose() {
      calls.push({ method: "dispose" });
    },
  };
}

function makeClient({ setValueSucceeds = true } = {}) {
  const calls = [];
  return {
    calls,
    async callTool(name, argumentsJson) {
      calls.push({ name, args: JSON.parse(argumentsJson) });
      if (name === "get_window_state")
        return { structuredJson: JSON.stringify({ elements: ELEMENTS }), isError: false };
      if (name === "set_value") return { isError: !setValueSucceeds };
      return { isError: false };
    },
  };
}

test("click 用 element_index 定位到屏幕 (398,928) 并激活后点击", async () => {
  const backend = makeBackend();
  const client = makeClient();
  const executor = createCompatExecutor({ backend, client });
  const result = await executor.execute({
    toolName: "click",
    arguments: { pid: 100, window_id: 31, element_index: 202 },
  });
  assert.equal(result.isError, false);
  assert.equal(result._meta.actionSent, true);
  assert.deepEqual(
    backend.calls.map((call) => call.method),
    ["listWindows", "monitors", "activate", "click"],
  );
  assert.deepEqual(backend.calls.at(-1), { method: "click", x: 398, y: 928, button: "left" });
});

test("click 支持 element_token 与右键", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  await executor.execute({
    toolName: "right_click",
    arguments: { pid: 100, window_id: 31, element_token: "s1:202" },
  });
  assert.deepEqual(backend.calls.at(-1), { method: "click", x: 398, y: 928, button: "right" });
});

test("click 缺元素定位时返回 ACTION_UNAVAILABLE，不投递", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  const result = await executor.execute({
    toolName: "click",
    arguments: { pid: 100, window_id: 31, x: 1, y: 2 },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "ACTION_UNAVAILABLE");
  assert.equal(result._meta.actionSent, false);
  assert.equal(backend.calls.length, 0);
});

test("element 不在新 snapshot 中时报 ACTION_UNAVAILABLE", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  const result = await executor.execute({
    toolName: "click",
    arguments: { pid: 100, window_id: 31, element_index: 999 },
  });
  assert.equal(result.isError, true);
  assert.equal(backend.calls.length, 0);
});

test("hotkey 拆成修饰键 + 末键", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  await executor.execute({
    toolName: "hotkey",
    arguments: { pid: 100, window_id: 31, keys: ["ctrl", "shift", "t"] },
  });
  assert.deepEqual(backend.calls.at(-1), { method: "hotkey", mods: ["ctrl", "shift"], key: "t" });
});

test("press_key 无修饰键走 pressKey，有则走 hotkey", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  await executor.execute({ toolName: "press_key", arguments: { window_id: 31, key: "enter" } });
  assert.deepEqual(backend.calls.at(-1), { method: "pressKey", key: "enter" });
  await executor.execute({
    toolName: "press_key",
    arguments: { window_id: 31, key: "c", modifiers: ["ctrl"] },
  });
  assert.deepEqual(backend.calls.at(-1), { method: "hotkey", mods: ["ctrl"], key: "c" });
});

test("type_text 分级：set_value → keycode → UTF-8 码点", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({
    backend,
    client: makeClient({ setValueSucceeds: true }),
  });

  const viaSet = await executor.execute({
    toolName: "type_text",
    arguments: { pid: 100, window_id: 31, element_token: "s1:202", text: "你好" },
  });
  assert.equal(viaSet._meta.textLevel, "set_value");
  assert.equal(backend.calls.length, 0);

  const viaKeys = await executor.execute({
    toolName: "type_text",
    arguments: { window_id: 31, text: "hi" },
  });
  assert.equal(viaKeys._meta.textLevel, "keycode");
  assert.deepEqual(backend.calls.at(-1), { method: "typeAscii", text: "hi" });

  const viaCode = await executor.execute({
    toolName: "type_text",
    arguments: { window_id: 31, text: "你好 π" },
  });
  assert.equal(viaCode._meta.textLevel, "codepoint");
  assert.deepEqual(backend.calls.at(-1), { method: "typeUnicode", text: "你好 π" });
});

test("scroll 把指针移到窗口中心再滚轮", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  const result = await executor.execute({
    toolName: "scroll",
    arguments: { pid: 100, window_id: 31, direction: "down", amount: 5 },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(backend.calls.at(-2), { method: "moveTo", x: 802, y: 600 });
  assert.deepEqual(backend.calls.at(-1), { method: "scroll", direction: "down", amount: 5 });
  const bad = await executor.execute({
    toolName: "scroll",
    arguments: { window_id: 31, direction: "diagonal" },
  });
  assert.equal(bad.structuredContent.code, "ACTION_UNAVAILABLE");
});

test("drag 用窗口本地像素换算到屏幕", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  const result = await executor.execute({
    toolName: "drag",
    arguments: {
      pid: 100,
      window_id: 31,
      from_x: 10,
      from_y: 20,
      to_x: 100,
      to_y: 200,
      button: "left",
      steps: 8,
    },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(backend.calls.at(-1), {
    method: "drag",
    from: { x: 142, y: 98 },
    to: { x: 322, y: 458 },
    opts: { button: "left", steps: 8 },
  });
});

test("drag 支持元素端点，缺端点时 ACTION_UNAVAILABLE", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  await executor.execute({
    toolName: "drag",
    arguments: { pid: 100, window_id: 31, from_element_index: 202, to_element_index: 202 },
  });
  assert.deepEqual(backend.calls.at(-1).from, { x: 398, y: 928 });
  const bad = await executor.execute({ toolName: "drag", arguments: { window_id: 31 } });
  assert.equal(bad.structuredContent.code, "ACTION_UNAVAILABLE");
});

test("mouse_drag 等未实现原语返回 ACTION_UNAVAILABLE", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  for (const tool of ["mouse_drag", "mouse_button_down"]) {
    const result = await executor.execute({ toolName: tool, arguments: {} });
    assert.equal(result.isError, true, tool);
    assert.equal(result.structuredContent.code, "ACTION_UNAVAILABLE", tool);
    assert.match(result.content[0].text, /not supported/i);
  }
  assert.equal(backend.calls.length, 0);
});

test("backend 抛错时转成错误结果，不伪造成功", async () => {
  const backend = makeBackend();
  backend.click = async () => {
    throw new Error("mutter session lost");
  };
  const executor = createCompatExecutor({ backend, client: makeClient() });
  const result = await executor.execute({
    toolName: "click",
    arguments: { pid: 100, window_id: 31, element_index: 202 },
  });
  assert.equal(result.isError, true);
  assert.equal(result._meta.actionSent, false);
  assert.match(result.content[0].text, /mutter session lost/);
});

test("dispose 转发到 backend", async () => {
  const backend = makeBackend();
  const executor = createCompatExecutor({ backend, client: makeClient() });
  await executor.dispose();
  assert.deepEqual(backend.calls.at(-1), { method: "dispose" });
});
