/**
 * `compatible/backend.js` 单测。
 *
 * 覆盖 `.agents/specs/computer-use-wayland-input.md` §6、§7 的组合行为：
 * click 的 移动→按下→抬起、hotkey 顺序、type_text 分级、变 scale、错误边界。
 * helper 用假端口，验证后端只组合原语、不自行缓存或注入。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createWaylandInputBackend } from "../compatible/backend.js";

function makeHelper({ monitors, cursor = { x: 0, y: 0 } } = {}) {
  const calls = [];
  const monitorList = monitors ?? [{ x: 0, y: 0, w: 1600, h: 1000, scale: 2, primary: true }];
  const responder = (method) => {
    if (method === "monitors") return monitorList;
    if (method === "getCursor") return cursor;
    if (method === "activate") return true;
    if (method === "listWindows") return [];
    if (method === "capture") return { pngBase64: "", width: 0, height: 0 };
    return { ok: true };
  };
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      return responder(method);
    },
  };
}

const noSleep = async () => {};
const codes = (helper) => helper.calls.map((call) => [call.params.code, call.params.pressed]);

test("缺少 helper 端口时拒绝构造", () => {
  assert.throws(() => createWaylandInputBackend({}), /helper port/);
});

test("scroll 映射到 mutter 轴：axis 0=垂直、1=水平，符号表方向", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  assert.deepEqual(await backend.scroll("down", 5), { axis: 0, steps: 5 });
  assert.deepEqual(await backend.scroll("up", 3), { axis: 0, steps: -3 });
  assert.deepEqual(await backend.scroll("right", 2), { axis: 1, steps: 2 });
  assert.deepEqual(await backend.scroll("left", 4), { axis: 1, steps: -4 });
  assert.deepEqual(
    helper.calls.map((call) => call.params),
    [
      { axis: 0, steps: 5 },
      { axis: 0, steps: -3 },
      { axis: 1, steps: 2 },
      { axis: 1, steps: -4 },
    ],
  );
  await assert.rejects(() => backend.scroll("down", 0), /non-zero/);
});

test("drag：按住左键分步相对移动后抬起", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  await backend.drag({ x: 400, y: 928 }, { x: 800, y: 928 }, { steps: 2 });
  assert.deepEqual(
    helper.calls.map((call) => call.method),
    ["monitors", "getCursor", "moveRel", "button", "moveRel", "moveRel", "button"],
  );
  assert.deepEqual(helper.calls[2].params, { dx: 200, dy: 464 });
  assert.deepEqual(
    helper.calls
      .filter((call) => call.method === "button")
      .map((call) => [call.params.code, call.params.pressed]),
    [
      [272, true],
      [272, false],
    ],
  );
});

test("click：先移动（除以 scale）再按下/抬起左键 272", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  await backend.click(400, 928);
  assert.deepEqual(
    helper.calls.map((call) => call.method),
    ["getCursor", "monitors", "moveRel", "button", "button"],
  );
  assert.deepEqual(helper.calls[2].params, { dx: 200, dy: 464 });
  assert.deepEqual(
    helper.calls.slice(3).map((call) => call.params),
    [
      { code: 272, pressed: true },
      { code: 272, pressed: false },
    ],
  );
});

test("click 支持右键/中键，未知键报错", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  await backend.click(0, 0, "right");
  assert.equal(helper.calls.at(-1).params.code, 273);
  await assert.rejects(() => backend.click(0, 0, "nope"), /unknown mouse button/);
});

test("hotkey 是 down(mods) → tap(key) → up(mods 逆序)", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  await backend.hotkey(["ctrl", "shift"], "t");
  assert.deepEqual(codes(helper), [
    [29, true],
    [42, true],
    [20, true],
    [20, false],
    [42, false],
    [29, false],
  ]);
});

test("pressKey 的大写字符自动包 Shift", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  await backend.pressKey("A");
  assert.deepEqual(codes(helper), [
    [42, true],
    [30, true],
    [30, false],
    [42, false],
  ]);
});

test("typeAscii 逐键，字母/Shift 标点正确", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  await backend.typeAscii("aB!");
  assert.deepEqual(codes(helper), [
    [30, true],
    [30, false],
    [42, true],
    [48, true],
    [48, false],
    [42, false],
    [42, true],
    [2, true],
    [2, false],
    [42, false],
  ]);
  await assert.rejects(() => backend.typeAscii("π"), /ASCII/);
});

test("typeText 分级：set_value → keycode → UTF-8 码点", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });

  const viaSet = await backend.typeText("你好", { trySetValue: async () => true });
  assert.equal(viaSet.level, "set_value");
  assert.equal(helper.calls.length, 0);

  const viaKeys = await backend.typeText("hi", { trySetValue: async () => false });
  assert.equal(viaKeys.level, "keycode");
  assert.ok(helper.calls.length > 0);

  helper.calls.length = 0;
  const viaCode = await backend.typeText("你好", {});
  assert.equal(viaCode.level, "codepoint");
  assert.ok(helper.calls.some((call) => call.method === "keycode"));
});

test("typeUnicode 用 Ctrl+Shift+U + 十六进制 + Enter", async () => {
  const helper = makeHelper();
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  await backend.typeUnicode("π"); // U+03C0 → hex "3c0"
  assert.deepEqual(codes(helper), [
    [29, true],
    [42, true],
    [22, true],
    [22, false],
    [42, false],
    [29, false],
    [4, true],
    [4, false], // '3'
    [46, true],
    [46, false], // 'c'
    [11, true],
    [11, false], // '0'
    [28, true],
    [28, false], // Enter
  ]);
});

test("变 scale：按目标点所在 monitor 取 scale", async () => {
  const monitors = [
    { x: 0, y: 0, w: 1600, h: 1000, scale: 1, primary: true },
    { x: 1600, y: 0, w: 1920, h: 1080, scale: 2, primary: false },
  ];
  const helper = makeHelper({ monitors });
  const backend = createWaylandInputBackend({ helper, sleep: noSleep });
  assert.equal(await backend.scaleFor({ x: 800, y: 500 }), 1);
  assert.equal(await backend.scaleFor({ x: 4000, y: 500 }), 2);

  helper.calls.length = 0;
  await backend.moveTo(4000, 500);
  assert.deepEqual(helper.calls.find((call) => call.method === "moveRel").params, {
    dx: 2000,
    dy: 250,
  });
});
