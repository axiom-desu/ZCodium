import assert from "node:assert/strict";
import test from "node:test";
import { createTuiInitialState } from "../src/app-initial-state.js";
import type { TuiOptions, TuiSubmitPromptResult } from "../src/types.js";

function options(overrides: Partial<TuiOptions> = {}): TuiOptions {
  return {
    noColor: true,
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
    submitPrompt: () => Promise.resolve({ response: "" } as TuiSubmitPromptResult),
    workspaceDirectory: "/workspace",
    ...overrides,
  };
}

test("启动快照优先使用 initialResult，并把 startup 结果落成 transcript 消息", () => {
  const state = createTuiInitialState(
    options({
      initialMode: "plan",
      initialModel: "static-model",
      initialResult: {
        effortOptions: [{ id: "effort-1", label: "Fast" }],
        mode: "build",
        model: "result-model",
        response: "restored output",
        selection: {
          emptyMessage: "",
          items: [],
          prompt: "resume prompt",
          title: "Resume",
        },
        thoughtLevel: "high",
      },
    }),
  );

  assert.equal(state.mode, "build");
  assert.equal(state.model, "result-model");
  assert.equal(state.thoughtLevel, "high");
  assert.equal(state.status, "resume prompt");
  assert.deepEqual(state.effortOptions, [{ id: "effort-1", label: "Fast" }]);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.content, "restored output");
  assert.equal(state.modelSetupRequired, false);
});

test("缺少 initialResult 时回落到 options 的静态默认值", () => {
  const state = createTuiInitialState(
    options({
      initialMode: "plan",
      initialModel: "static-model",
      initialThoughtLevel: "low",
      locale: "zh-CN",
      modelSetupRequired: true,
    }),
  );

  assert.equal(state.mode, "plan");
  assert.equal(state.model, "static-model");
  assert.equal(state.thoughtLevel, "low");
  assert.equal(state.locale, "zh-CN");
  assert.equal(state.modelSetupRequired, true);
  assert.deepEqual(state.messages, []);
  assert.equal(state.selection, undefined);
  assert.notEqual(state.status, "");
});

test("没有任何初始输入时使用就绪默认值", () => {
  const state = createTuiInitialState(options());
  assert.equal(state.mode, "build");
  assert.equal(state.model, "unknown");
  assert.equal(state.locale, "en-US");
  assert.equal(state.modelSetupRequired, false);
  assert.match(state.status, /ready/i);
});
