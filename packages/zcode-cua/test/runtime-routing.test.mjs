/**
 * `createComputerUseRuntime` 的兼容层路由单测。
 *
 * 覆盖 `.agents/specs/computer-use-wayland-input.md` §8.1：
 * 输入类工具在 compat.applies 时走兼容层；观察/语义始终走 cua-driver。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createCuaDriverRuntime, createComputerUseRuntime } from "../index.js";

const CONTEXT = { sessionId: "s1", runtimeScope: "main", workspaceKey: "ws" };

function makeClient(calls) {
  return {
    async callTool(name, argumentsJson) {
      calls.push({ target: "driver", name, args: JSON.parse(argumentsJson) });
      return { text: "ok", images: [], isError: false, degraded: false, rawJson: "{}" };
    },
    async dispose() {
      calls.push({ target: "driver.dispose" });
    },
  };
}

function makeCompat(applies, calls) {
  return {
    applies,
    async execute(input) {
      calls.push({ target: "compat", toolName: input.toolName, args: input.arguments });
      return { content: [{ type: "text", text: "compat ok" }], isError: false };
    },
    async dispose() {
      calls.push({ target: "compat.dispose" });
    },
  };
}

test("applies 时输入类工具走兼容层，driver 不被调用", async () => {
  const calls = [];
  const runtime = createCuaDriverRuntime(makeClient(calls), { compat: makeCompat(true, calls) });
  const result = await runtime.execute({
    toolName: "type_text",
    arguments: { text: "hi" },
    context: CONTEXT,
  });
  assert.equal(result.isError, false);
  assert.deepEqual(calls, [{ target: "compat", toolName: "type_text", args: { text: "hi" } }]);
});

test("applies 时 cua-driver 原生观察/语义名仍只走 driver", async () => {
  const calls = [];
  const runtime = createCuaDriverRuntime(makeClient(calls), { compat: makeCompat(true, calls) });
  for (const toolName of [
    "get_window_state",
    "get_desktop_state",
    "zoom",
    "get_accessibility_tree",
  ]) {
    await runtime.execute({ toolName, arguments: { pid: 1 }, context: CONTEXT });
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.target === "driver"));
});

test("applies=false 时输入类工具走 driver", async () => {
  const calls = [];
  const runtime = createCuaDriverRuntime(makeClient(calls), { compat: makeCompat(false, calls) });
  await runtime.execute({ toolName: "click", arguments: { pid: 1 }, context: CONTEXT });
  assert.equal(calls[0].target, "driver");
  assert.equal(calls[0].name, "click");
});

test("没有 compat 时行为不变", async () => {
  const calls = [];
  const runtime = createComputerUseRuntime({ client: makeClient(calls) });
  await runtime.execute({ toolName: "click", arguments: {}, context: CONTEXT });
  assert.equal(calls[0].target, "driver");
});

test("未知工具名不被兼容层接管，透传 driver", async () => {
  const calls = [];
  const runtime = createCuaDriverRuntime(makeClient(calls), { compat: makeCompat(true, calls) });
  await runtime.execute({ toolName: "bring_to_front", arguments: {}, context: CONTEXT });
  assert.equal(calls[0].target, "driver");
});

test("dispose 先关兼容层再关 driver", async () => {
  const calls = [];
  const runtime = createCuaDriverRuntime(makeClient(calls), { compat: makeCompat(true, calls) });
  await runtime.dispose();
  assert.deepEqual(calls, [{ target: "compat.dispose" }, { target: "driver.dispose" }]);
});
