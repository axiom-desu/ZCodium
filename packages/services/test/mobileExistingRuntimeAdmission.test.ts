import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";

async function setup() {
  let alive = true;
  let starts = 0;
  let createFailure: Error | undefined;
  const request = vi.fn(async (method: string) => {
    if (method === zcodeProtocolMethods.sessionCreate && createFailure) throw createFailure;
    if (method === zcodeProtocolMethods.sessionCreate)
      return {
        session: { sessionId: "created" },
        messages: [],
        settings: { model: { current: undefined } },
      };
    return {};
  });
  const client = {
    request,
    get isDisposed() {
      return !alive;
    },
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
  };
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      markReady() {}
      async getClient() {
        starts++;
        return client;
      }
      getExistingClient() {
        return alive && starts ? client : undefined;
      }
      async getRuntimeIdentity() {
        if (!alive || !starts) throw new Error("unavailable");
        return { identity: "runtime-1", generation: 1, workspaceKey: "/tmp/work" };
      }
      disposeAll() {}
    },
  }));
  let release: (() => void) | undefined;
  let prepareCalled = 0;
  let block = false;
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    modelSelectionReadinessSource: {
      getView: async () =>
        ({ revision: 1, providers: [{ providerId: "p", models: [{ modelId: "m" }] }] }) as never,
    },
    prepareSessionCreation: async () => {
      prepareCalled++;
      if (block)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return ["/frozen"];
    },
  });
  return {
    service,
    request,
    failCreate: () => {
      createFailure = new Error("unknown delivery result");
    },
    starts: () => starts,
    kill: () => {
      alive = false;
    },
    block: () => {
      block = true;
    },
    release: () => release?.(),
    prepared: () => prepareCalled,
  };
}
const target = { workspacePath: "/tmp/work" };

describe("Host existing-runtime admission", () => {
  it("unknown runtime refuses before prepare with zero starts", async () => {
    const f = await setup();
    await expect(f.service.acquireExistingRuntime(target)).rejects.toThrow(/runtime/u);
    expect(f.starts()).toBe(0);
    expect(f.prepared()).toBe(0);
    f.service.disposeAll();
  });
  it("desktop starts once; guarded creation uses same client and frozen directories without another acquisition", async () => {
    const f = await setup();
    await f.service.initialize(target);
    expect(f.starts()).toBe(1);
    const admission = await f.service.acquireExistingRuntime(target);
    await admission.createSession({ ...target, projectId: "project" });
    expect(f.starts()).toBe(1);
    const calls = f.request.mock.calls.filter(
      ([method]) => method === zcodeProtocolMethods.sessionCreate,
    );
    expect(calls).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith(
      zcodeProtocolMethods.sessionCreate,
      expect.objectContaining({ additionalDirectories: ["/frozen"] }),
      expect.anything(),
      undefined,
    );
    f.service.disposeAll();
  });
  it("unknown delivery result is not retried or sent to a replacement owner", async () => {
    const f = await setup();
    await f.service.initialize(target);
    const admission = await f.service.acquireExistingRuntime(target);
    f.failCreate();
    await expect(admission.createSession(target)).rejects.toThrow("unknown delivery result");
    expect(
      f.request.mock.calls.filter(([method]) => method === zcodeProtocolMethods.sessionCreate),
    ).toHaveLength(1);
    expect(f.starts()).toBe(1);
    f.service.disposeAll();
  });
  it("attachment epoch revoked during prepare cannot reach actor", async () => {
    const f = await setup();
    await f.service.initialize(target);
    let current = true;
    const admission = await f.service.acquireExistingRuntime(target, () => {
      if (!current) throw new Error("stale attachment");
    });
    f.block();
    const pending = admission.createSession(target);
    await vi.waitFor(() => expect(f.prepared()).toBe(1));
    current = false;
    f.release();
    await expect(pending).rejects.toThrow("stale attachment");
    expect(f.starts()).toBe(1);
    expect(
      f.request.mock.calls.filter(([method]) => method === zcodeProtocolMethods.sessionCreate),
    ).toHaveLength(0);
    f.service.disposeAll();
  });
  it("forged RPC admission cannot reach prepare or start", async () => {
    const f = await setup();
    await expect(f.service.createSession(target, {} as never)).rejects.toThrow(
      "invalid-runtime-admission",
    );
    expect(f.starts()).toBe(0);
    expect(f.prepared()).toBe(0);
    f.service.disposeAll();
  });
  it("kill during awaited reservation rejects without request/restart/retry", async () => {
    const f = await setup();
    await f.service.initialize(target);
    const admission = await f.service.acquireExistingRuntime(target);
    f.block();
    const pending = admission.createSession({ ...target, projectId: "project" });
    await vi.waitFor(() => expect(f.prepared()).toBe(1));
    f.kill();
    f.release();
    await expect(pending).rejects.toThrow(/runtime/u);
    expect(f.starts()).toBe(1);
    expect(
      f.request.mock.calls.filter(([method]) => method === zcodeProtocolMethods.sessionCreate),
    ).toHaveLength(0);
    f.service.disposeAll();
  });
});
