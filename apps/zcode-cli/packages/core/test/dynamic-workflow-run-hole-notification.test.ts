import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import type { TraceContext } from "../src/runtime/deps.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  HOLE_REACHED_EVENT_TYPE,
  notifyHoleReached,
} from "../src/runtime/methods/dynamic-workflow-run-hole-notification.js";

/**
 * P2 core：留白通知。纪律是「每条 `hole-reached` 恰好一条模型可见通知；`hole-filled` 不发」，
 * 这里直接对着发射器钉住这两条——不构造整个 AgentRuntime，只给发射器它读的那几样。
 */

interface RecordedNotification {
  text: string;
  taskId?: string;
}

function fakeRuntime(options: {
  snapshot?: unknown;
  port?: boolean;
}): { runtime: AgentRuntimeInternal; notifications: RecordedNotification[] } {
  const notifications: RecordedNotification[] = [];
  const runtime = {
    runtimeTaskRegistry: { get: () => ({ description: "My workflow" }) },
    dynamicWorkflowRunPort:
      options.port === false ? undefined : { getTask: async () => options.snapshot },
    logger: { warn: () => {} },
    enqueueBackgroundTaskNotification: (input: RecordedNotification) => {
      notifications.push(input);
    },
  };
  return { runtime: runtime as unknown as AgentRuntimeInternal, notifications };
}

function payload(eventType: string, body: Record<string, unknown>): DynamicWorkflowRunProgressPayload {
  return {
    runId: "dwfrun-1",
    sequence: 7,
    eventType,
    payload: body,
  } as unknown as DynamicWorkflowRunProgressPayload;
}

const trace = {} as TraceContext;

describe("notifyHoleReached", () => {
  it("每条 hole-reached 恰好一条通知，并念出快照补上的类型与草稿行", async () => {
    const { runtime, notifications } = fakeRuntime({
      snapshot: {
        runStatus: "running",
        scriptPath: "/tmp/plan.dwf.ts",
        holes: [
          {
            siteId: "hole#abc",
            ordinal: 1,
            name: "decide",
            type: "string",
            state: "waiting",
            since: 10,
            line: 3,
            before: "start",
            after: "build",
          },
        ],
      },
    });
    await notifyHoleReached.call(
      runtime,
      payload(HOLE_REACHED_EVENT_TYPE, {
        instance: { siteId: "hole#abc", ordinal: 1 },
        name: "decide",
        prompt: "pick a word",
      }),
      trace,
    );

    assert.equal(notifications.length, 1);
    const [notification] = notifications;
    assert.equal(notification?.taskId, "dwfrun-1");
    assert.match(notification?.text ?? "", /FillWorkflowHole/);
    assert.match(notification?.text ?? "", /hole#abc/);
    assert.match(notification?.text ?? "", /<type>string<\/type>/);
    assert.match(notification?.text ?? "", /\/tmp\/plan\.dwf\.ts/);
    assert.match(notification?.text ?? "", /between phases "start" and "build"/);
  });

  it("hole-filled 不发通知", async () => {
    const { runtime, notifications } = fakeRuntime({ snapshot: { holes: [] } });
    await notifyHoleReached.call(
      runtime,
      payload("hole-filled", { siteId: "hole#abc", filledAt: 1 }),
      trace,
    );
    assert.equal(notifications.length, 0);
  });

  it("端口缺席时通知照发，退回载荷自己说得出的字段", async () => {
    const { runtime, notifications } = fakeRuntime({ port: false });
    await notifyHoleReached.call(
      runtime,
      payload(HOLE_REACHED_EVENT_TYPE, {
        instance: { siteId: "hole#abc", ordinal: 1 },
        name: "decide",
      }),
      trace,
    );
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]?.text ?? "", /<type>unknown<\/type>/);
  });
});
