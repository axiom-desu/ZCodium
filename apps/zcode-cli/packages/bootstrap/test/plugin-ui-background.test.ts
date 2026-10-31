import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";

const ui = { pluginId: "editor@example", resourceUri: "ui://editor", surface: "editor" };
function events(success = true, isError = false): SessionEvent[] {
  return [
    [SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 }],
    [SessionEventType.TurnStarted, { turnNumber: 1, input: "open", inputId: "cmd" }],
    [
      SessionEventType.ToolCallScheduled,
      {
        toolCallId: "tool",
        toolName: "mcp__editor__open",
        input: { file: "drawing.png" },
        schedule: { parallelGroups: [["tool"]], executionOrder: ["tool"] },
      },
    ],
    [
      SessionEventType.ToolCallResult,
      {
        toolCallId: "tool",
        duration: 1,
        result: {
          success,
          content: "opened",
          display: {
            kind: "mcp_tool",
            serverName: "plugin:editor:editor",
            toolName: "open",
            ui: { ...ui, ...(isError ? { isError: true } : {}) },
          },
        },
      },
    ],
  ].map(
    ([type, payload], index) =>
      ({
        id: `event-${index}` as never,
        sessionId: "session-1" as never,
        turnId: "turn-1" as never,
        traceId: "trace" as never,
        type,
        payload,
        timestamp: new Date(1000 + index),
        sequenceNumber: index + 1,
      }) as SessionEvent,
  );
}
function setup(history: SessionEvent[] = []) {
  const emitted: unknown[] = [];
  const frames: unknown[] = [];
  const gateway = new ConversationV4Gateway({
    sessionExists: () => true,
    emitWireFrame: (frame) => frames.push(frame),
    emitPluginUiToolResult: (result) => emitted.push(result),
    loadPersistedEvents: async () => ({ events: history, synthesized: false }),
  } as never);
  return { gateway, emitted, frames };
}

test("后台 UI 工具结果无 conversation 订阅时投递一次", () => {
  const { gateway, emitted, frames } = setup();
  try {
    const live = events();
    for (const event of live) gateway.ingest("session-1", event);
    gateway.ingest("session-1", live.at(-1)!);
    assert.equal(frames.length, 0);
    assert.deepEqual(emitted, [
      {
        sessionId: "session-1",
        toolCallId: "tool",
        serverName: "plugin:editor:editor",
        ui,
        input: { file: "drawing.png" },
      },
    ]);
  } finally {
    gateway.dispose();
  }
});

test("失败或 isError 结果不创建后台 guest", () => {
  for (const [success, isError] of [
    [false, false],
    [true, true],
  ] as const) {
    const { gateway, emitted } = setup();
    try {
      for (const event of events(success, isError)) gateway.ingest("session-1", event);
      assert.deepEqual(emitted, []);
    } finally {
      gateway.dispose();
    }
  }
});

test("订阅历史不重新触发创建副作用", async () => {
  const { gateway, emitted } = setup(events());
  try {
    await gateway.subscribe({
      connectionId: "history",
      clientMode: "desktop-continuous",
      topic: "conversation/session-1",
    });
    assert.deepEqual(emitted, []);
  } finally {
    gateway.dispose();
  }
});
