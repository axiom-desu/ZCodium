import { describe, expect, it, vi } from "vitest";
import type { ExtensionCapabilityRequest } from "@zcode/shared/extension-host";
import { createCapabilityGateway, type GatewayPorts } from "./gateway.js";

const PLUGIN = {
  pluginId: "demo",
  name: "Demo",
  version: "1.0.0",
  capabilities: ["settings.get", "projects.list", "context.get"],
  slotIds: ["status-projects"],
  protocols: { projects: 1 },
  declared: ["projects.read" as const],
};

const AUTH = { token: "t".repeat(32), pluginId: "demo" };

const SESSIONS_PLUGIN = {
  ...PLUGIN,
  capabilities: [
    "settings.get",
    "sessions.listProjects",
    "sessions.listSessions",
    "sessions.readSession",
    "sessions.waitSessions",
    "sessions.renameSession",
  ],
  protocols: { projects: 1, sessions: 1 },
  declared: ["projects.read" as const, "sessions.write" as const],
};

function sessionListResult() {
  return {
    sessions: [],
    searchScope: {
      scopes: [{ kind: "app", scope: "host", sourceServerId: "local" }],
      unavailableSources: [],
    },
  };
}

function request(overrides: Partial<ExtensionCapabilityRequest> = {}): ExtensionCapabilityRequest {
  return {
    v: 1,
    generation: 2,
    workspaceIdentity: "local:/tmp/ws",
    pluginId: "demo",
    capabilityId: "projects.list",
    requestId: "req-1",
    ...overrides,
  };
}

function ports(overrides: Partial<GatewayPorts> = {}): GatewayPorts {
  return {
    currentGeneration: () => 2,
    currentWorkspaceIdentity: () => "local:/tmp/ws",
    authenticate: (token) =>
      token === AUTH.token ? "demo" : token === "b".repeat(32) ? "other" : null,
    consented: () => true,
    plugin: () => PLUGIN,
    granted: () => ["projects.read"],
    dispatch: async () => [{ id: "p1", name: "Project One" }],
    onContribution: () => 7,
    ...overrides,
  };
}

describe("extension capability gateway", () => {
  it("rejects unapproved capabilities without calling the backing service", async () => {
    const dispatch = vi.fn();
    const gateway = createCapabilityGateway(ports({ granted: () => [], dispatch }));
    const response = await gateway.call(request(), AUTH);
    expect(response).toEqual({ ok: false, code: "not-granted", message: expect.any(String) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects undeclared capabilities and unknown capability ids", async () => {
    const gateway = createCapabilityGateway(
      ports({ plugin: () => ({ ...PLUGIN, capabilities: ["settings.get"] }) }),
    );
    expect((await gateway.call(request(), AUTH)).ok).toBe(false);
    const unknown = createCapabilityGateway(ports());
    expect(await unknown.call(request({ capabilityId: "files.readAny" }), AUTH)).toMatchObject({
      code: "unknown-capability",
    });
  });

  it("rejects stale generations, wrong workspaces and invalid tokens", async () => {
    const gateway = createCapabilityGateway(ports());
    expect(await gateway.call(request({ generation: 1 }), AUTH)).toMatchObject({
      code: "stale-generation",
    });
    expect(
      await gateway.call(request({ workspaceIdentity: "local:/tmp/other" }), AUTH),
    ).toMatchObject({ code: "workspace-mismatch" });
    expect(
      await gateway.call(request(), { token: "x".repeat(32), pluginId: "demo" }),
    ).toMatchObject({ code: "unauthorized" });
  });

  it("binds the authenticated credential to one plugin identity", async () => {
    const dispatch = vi.fn();
    const gateway = createCapabilityGateway(ports({ dispatch }));
    // A 的合法凭据不能通过 body 声称 B；身份只来自 transport。
    expect(await gateway.call(request({ pluginId: "other" }), AUTH)).toMatchObject({
      code: "unauthorized",
    });
    // B 的凭据也不能反向声称 A。
    expect(
      await gateway.call(request({ pluginId: "demo" }), {
        token: "b".repeat(32),
        pluginId: "other",
      }),
    ).toMatchObject({ code: "unauthorized" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("calls the existing service only after a grant exists", async () => {
    const dispatch = vi.fn(async () => [{ id: "p1", name: "Project One" }]);
    const gateway = createCapabilityGateway(ports({ dispatch }));
    const response = await gateway.call(request(), AUTH);
    expect(response).toEqual({ ok: true, result: [{ id: "p1", name: "Project One" }] });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("admits session reads with the write grant and passes the authenticated identity down", async () => {
    const dispatch = vi.fn(async () => sessionListResult());
    const gateway = createCapabilityGateway(
      ports({ plugin: () => SESSIONS_PLUGIN, granted: () => ["sessions.write"], dispatch }),
    );
    const response = await gateway.call(
      request({ capabilityId: "sessions.listSessions", input: {} }),
      AUTH,
    );
    expect(response.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      pluginId: "demo",
      generation: 2,
      capabilityId: "sessions.listSessions",
      input: expect.objectContaining({ archived: "exclude" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("refuses session writes without the write grant", async () => {
    const dispatch = vi.fn();
    const gateway = createCapabilityGateway(
      ports({ plugin: () => SESSIONS_PLUGIN, granted: () => ["sessions.read"], dispatch }),
    );
    const response = await gateway.call(
      request({
        capabilityId: "sessions.renameSession",
        input: { sessionId: "sess_a", title: "Renamed", requestId: "req-1" },
      }),
      AUTH,
    );
    expect(response).toMatchObject({ ok: false, code: "not-granted" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a session projection whose declared version does not match", async () => {
    const dispatch = vi.fn();
    const gateway = createCapabilityGateway(
      ports({
        plugin: () => ({ ...SESSIONS_PLUGIN, protocols: { projects: 1, sessions: 99 } }),
        granted: () => ["sessions.write"],
        dispatch,
      }),
    );
    const response = await gateway.call(
      request({ capabilityId: "sessions.listSessions", input: {} }),
      AUTH,
    );
    expect(response).toMatchObject({ ok: false, code: "incompatible" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses session writes without the write grant", async () => {
    const dispatch = vi.fn();
    const gateway = createCapabilityGateway(
      ports({ plugin: () => SESSIONS_PLUGIN, granted: () => ["sessions.read"], dispatch }),
    );
    const response = await gateway.call(
      request({
        capabilityId: "sessions.renameSession",
        input: { sessionId: "sess_a", title: "Renamed", requestId: "req-1" },
      }),
      AUTH,
    );
    expect(response).toMatchObject({ ok: false, code: "not-granted" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses undeclared session capabilities and session reads without any grant", async () => {
    const dispatch = vi.fn();
    const undeclared = createCapabilityGateway(
      ports({
        plugin: () => ({
          ...SESSIONS_PLUGIN,
          capabilities: SESSIONS_PLUGIN.capabilities.filter((id) => id !== "sessions.readSession"),
        }),
        granted: () => ["sessions.write"],
        dispatch,
      }),
    );
    expect(
      await undeclared.call(
        request({
          capabilityId: "sessions.readSession",
          input: { sessionId: "sess_a", view: "messages" },
        }),
        AUTH,
      ),
    ).toMatchObject({ ok: false, code: "not-declared" });
    // 只有 projects.read：会话读/写都不能被它覆盖。
    const unread = createCapabilityGateway(
      ports({ plugin: () => SESSIONS_PLUGIN, granted: () => ["projects.read"], dispatch }),
    );
    expect(
      await unread.call(request({ capabilityId: "sessions.listSessions", input: {} }), AUTH),
    ).toMatchObject({ ok: false, code: "not-granted" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("validates session input and output with the shared canonical schemas", async () => {
    const dispatch = vi.fn(async () => ({ status: "applied", requestId: "req-1" }));
    const gateway = createCapabilityGateway(
      ports({ plugin: () => SESSIONS_PLUGIN, granted: () => ["sessions.write"], dispatch }),
    );
    // strictObject：没在 canonical 输入里的字段直接拒绝，不能靠 unknown→cast 绕过。
    expect(
      await gateway.call(
        request({
          capabilityId: "sessions.renameSession",
          input: { sessionId: "sess_a", title: "Renamed", requestId: "req-1", bypass: true },
        }),
        AUTH,
      ),
    ).toMatchObject({ ok: false, code: "invalid-input" });
    expect(dispatch).not.toHaveBeenCalled();

    // 输出同样按 canonical schema 复验：缺 requestId 的 mutation 回执不能当成功。
    const invalidOutput = createCapabilityGateway(
      ports({
        plugin: () => SESSIONS_PLUGIN,
        granted: () => ["sessions.write"],
        dispatch: async () => ({ status: "applied" }),
      }),
    );
    expect(
      await invalidOutput.call(
        request({
          capabilityId: "sessions.renameSession",
          input: { sessionId: "sess_a", title: "Renamed", requestId: "req-1" },
        }),
        AUTH,
      ),
    ).toMatchObject({ ok: false, code: "backend-error" });
  });

  it("cancels an in-flight waitSessions on stop and never publishes its result", async () => {
    let seenSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const dispatch = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          seenSignal = signal;
          release = () =>
            resolve({
              status: "completed",
              operations: [],
            });
        }),
    );
    const gateway = createCapabilityGateway(
      ports({ plugin: () => SESSIONS_PLUGIN, granted: () => ["sessions.read"], dispatch }),
    );
    const pending = gateway.call(
      request({
        capabilityId: "sessions.waitSessions",
        input: { operations: [{ sessionId: "sess_a", commandId: "cmd-1" }], mode: "any" },
      }),
      AUTH,
    );
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    gateway.cancelAll();
    expect(seenSignal?.aborted).toBe(true);
    release?.();
    expect(await pending).toMatchObject({ ok: false, code: "canceled" });
  });

  it("cancels in-flight calls on revoke and drops the late result", async () => {
    let seenSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    let granted = ["projects.read" as const];
    const dispatch = vi.fn(
      async ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          seenSignal = signal;
          release = () => resolve([{ id: "p1", name: "Project One" }]);
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const gateway = createCapabilityGateway(ports({ dispatch, granted: () => granted }));
    const pending = gateway.call(request(), AUTH);
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    granted = [];
    gateway.cancelPlugin("demo");
    expect(seenSignal?.aborted).toBe(true);
    release?.();
    expect(await pending).toMatchObject({ ok: false, code: "canceled" });
  });

  it("rechecks the grant after completion so a late success is not published", async () => {
    let granted = ["projects.read" as const];
    let release: (() => void) | undefined;
    const dispatch = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ id: "p1", name: "Project One" }]);
        }),
    );
    const gateway = createCapabilityGateway(ports({ dispatch, granted: () => granted }));
    const pending = gateway.call(request(), AUTH);
    await vi.waitFor(() => expect(release).toBeDefined());
    granted = [];
    release?.();
    expect(await pending).toMatchObject({ ok: false, code: "not-granted" });
  });

  it("rejects stale, revoked and undeclared contributions", async () => {
    const base = {
      v: 1 as const,
      workspaceIdentity: "local:/tmp/ws",
      pluginId: "demo",
    };
    const gateway = createCapabilityGateway(ports());
    expect(
      await gateway.contribute(
        {
          ...base,
          generation: 1,
          slots: [{ id: "status-projects", slot: "status.composer", title: "Projects" }],
        },
        AUTH,
      ),
    ).toMatchObject({ code: "stale-generation" });
    expect(
      await gateway.contribute(
        {
          ...base,
          generation: 2,
          slots: [{ id: "not-declared", slot: "status.composer", title: "Projects" }],
        },
        AUTH,
      ),
    ).toMatchObject({ code: "invalid-contribution" });
    expect(
      await gateway.contribute(
        {
          ...base,
          generation: 2,
          slots: [{ id: "status-projects", slot: "status.composer", title: "Projects" }],
        },
        AUTH,
      ),
    ).toEqual({ ok: true, revision: 7 });

    const revoked = createCapabilityGateway(ports({ consented: () => false }));
    expect(
      await revoked.contribute(
        {
          ...base,
          generation: 2,
          slots: [{ id: "status-projects", slot: "status.composer", title: "Projects" }],
        },
        AUTH,
      ),
    ).toMatchObject({ code: "not-granted" });
  });
});
