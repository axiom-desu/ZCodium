import assert from "node:assert/strict";
import { it } from "node:test";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import {
  SessionLifecycleController,
  getSessionLifecycle,
  type SessionLifecycleHost,
} from "../src/session-lifecycle/index.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

function workspace(identity: string): ZCodeWorkspaceRef {
  return {
    workspaceKey: identity,
    workspacePath: `/tmp/${identity}`,
    workspaceIdentity: identity,
  };
}

function harness(overrides: Partial<SessionLifecycleHost> = {}) {
  const events: string[] = [];
  let runtime = false;
  const host: SessionLifecycleHost = {
    exists: async (sessionId) => sessionId === "s1",
    hasRuntime: () => runtime,
    validateActivation: async () => undefined,
    activate: async () => {
      events.push("activate");
      runtime = true;
    },
    assertCanStop: () => undefined,
    release: async () => {
      events.push("release");
      runtime = false;
    },
    ...overrides,
  };
  return { controller: new SessionLifecycleController(host), events, host };
}

it("getState is read-only and reports unloaded without activating", async () => {
  let activations = 0;
  const { controller } = harness({
    activate: async () => {
      activations += 1;
    },
  });
  const snapshot = await controller.getState("s1");
  assert.equal(snapshot.state, "unloaded");
  assert.equal(snapshot.generation, 0);
  assert.equal(activations, 0);
  assert.equal(controller.isReady("s1"), false);
});

it("getState reports ready for an already resident runtime", async () => {
  const { controller } = harness({ hasRuntime: () => true });
  const snapshot = await controller.getState("s1");
  assert.equal(snapshot.state, "ready");
});

it("concurrent ensureReady shares one activation flight", async () => {
  const gate = Promise.withResolvers<void>();
  let activations = 0;
  const { controller, events } = harness({
    activate: async () => {
      activations += 1;
      events.push("activate-start");
      await gate.promise;
      events.push("activate-end");
    },
  });
  const first = controller.ensureReady("s1", workspace("w1"));
  const second = controller.ensureReady("s1", workspace("w1"));
  const third = controller.ensureReady("s1", workspace("w1"));
  // assertExists/validateActivation 是异步预检，等它们跑到 activate 后再计数。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(activations, 1);
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.equal(activations, 1);
  assert.deepEqual(events, ["activate-start", "activate-end"]);
  const snapshot = await controller.getState("s1");
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.generation, 1);
});

it("missing session rejects getState/ensureReady without side effects", async () => {
  let sideEffects = 0;
  const { controller } = harness({
    exists: async () => false,
    activate: async () => {
      sideEffects += 1;
    },
    release: async () => {
      sideEffects += 1;
    },
  });
  await assert.rejects(controller.getState("missing"), /Session not found/);
  await assert.rejects(controller.ensureReady("missing"), /Session not found/);
  assert.equal(sideEffects, 0);
});

it("stop then ensureReady serializes and activates after release settles", async () => {
  const releaseGate = Promise.withResolvers<void>();
  const { controller, events } = harness({
    hasRuntime: () => true,
    release: async () => {
      events.push("release-start");
      await releaseGate.promise;
      events.push("release-end");
    },
    activate: async () => {
      events.push("activate");
    },
  });
  const stop = controller.stop("s1");
  const ready = controller.ensureReady("s1", workspace("w1"));
  await Promise.resolve();
  releaseGate.resolve();
  await Promise.all([stop, ready]);
  assert.deepEqual(events, ["release-start", "release-end", "activate"]);
  assert.equal((await controller.getState("s1")).state, "ready");
});

it("restart waits for an in-flight startup and cannot be preempted by stop", async () => {
  const startupGate = Promise.withResolvers<void>();
  let activationCount = 0;
  const { controller, events } = harness({
    activate: async () => {
      activationCount += 1;
      if (activationCount === 1) {
        events.push("startup-start");
        await startupGate.promise;
        events.push("startup-end");
        return;
      }
      events.push("reactivate");
    },
    release: async () => {
      events.push("release");
    },
  });
  const startup = controller.ensureReady("s1", workspace("w1"));
  const restart = controller.restart("s1", workspace("w1"));
  await assert.rejects(controller.stop("s1"), /restart is pending/i);
  startupGate.resolve();
  await startup;
  await restart;
  assert.deepEqual(events, ["startup-start", "startup-end", "release", "reactivate"]);
  assert.equal((await controller.getState("s1")).state, "ready");
});

it("workspace conflict rejects before touching the runtime", async () => {
  const gate = Promise.withResolvers<void>();
  const { controller } = harness({
    activate: async () => {
      await gate.promise;
    },
  });
  const first = controller.ensureReady("s1", workspace("w1"));
  await assert.rejects(controller.ensureReady("s1", workspace("w2")), /workspace conflicts/);
  gate.resolve();
  await first;
});

it("release failure faults the session and blocks implicit recovery", async () => {
  const { controller } = harness({
    hasRuntime: () => true,
    release: async () => {
      throw new Error("resource release failed");
    },
  });
  await assert.rejects(controller.stop("s1"), /resource release failed/);
  const snapshot = await controller.getState("s1");
  assert.equal(snapshot.state, "faulted");
  assert.equal(snapshot.lastError?.operation, "stop");
  assert.equal(snapshot.lastError?.code, "resourceReleaseFailed");
  await assert.rejects(controller.ensureReady("s1"), /recovery/i);
});

it("host adapter releases the existing record through one owner and notifies state", async () => {
  const events: string[] = [];
  const notifications: string[] = [];
  const record = {
    app: { close: async () => void events.push("close") },
    eventStore: { deleteSession: async () => void events.push("event-store") },
    unsubscribe: () => events.push("unsubscribe"),
    workspace: workspace("w1"),
  };
  const context = {
    // stop 只释放运行实例；持久会话仍存在，getState 才能读到 unloaded 事实。
    deps: { sessionStore: { getSession: async () => ({ time: { deleted: undefined } }) } },
    logger: undefined,
    notify: (notification: { method: string }) => notifications.push(notification.method),
    sessions: new Map([["s1", record]]),
    v4Gateway: { deactivateSession: () => events.push("deactivate") },
  } as unknown as ZCodeProtocolAgentServerContext;
  const lifecycle = getSessionLifecycle(context);
  assert.equal((await lifecycle.getState("s1")).state, "ready");
  await lifecycle.stop("s1");
  assert.equal(context.sessions.size, 0);
  assert.deepEqual(events, ["unsubscribe", "deactivate", "close", "event-store"]);
  assert.equal((await lifecycle.getState("s1")).state, "unloaded");
  assert.ok(notifications.includes("session/lifecycle/changed"));
});

it("failed activation cleans up and never reports ready", async () => {
  const { controller, events } = harness({
    activate: async () => {
      events.push("activate");
      throw new Error("startup failed");
    },
    release: async () => {
      events.push("cleanup");
    },
  });
  await assert.rejects(controller.ensureReady("s1"), /startup failed/);
  assert.deepEqual(events, ["activate", "cleanup"]);
  assert.equal((await controller.getState("s1")).state, "unloaded");
  assert.equal((await controller.getState("s1")).lastError?.code, "operationFailed");
});
