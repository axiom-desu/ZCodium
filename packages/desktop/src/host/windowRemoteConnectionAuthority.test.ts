import { describe, expect, it } from "vitest";
import { buildRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";

function harness() {
  const calls: RemoteTarget[] = [];
  const released: Array<{ workspacePath: string; workspaceIdentity?: string }> = [];
  let next = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = createWindowRemoteConnectionRegistry({
    createId: () => `session-${++next}`,
    releaseWorkspace: async (_services, context) => {
      released.push(context);
    },
    connect: async ({ target }) => {
      calls.push(target);
      await barrier;
      const token = target.kind === "server" ? target.token : "shared";
      return {
        services: { id: token, endpoint: target.kind === "server" ? target.url : "transport" },
        sourceServerId:
          target.kind === "server" && target.url !== base.url
            ? "source-other-endpoint"
            : "source-real",
        sourceServerAuthProofDigest: `proof-${token}`,
        dispose() {},
      };
    },
  });
  return { registry, calls, released, release };
}

const base = {
  kind: "server" as const,
  url: "http://fixture.invalid:8123/team-a",
  token: "fixture-A",
};

describe("Source provisional authority isolation (auditor A1)", () => {
  for (const state of ["online", "connecting"] as const) {
    for (const [change, target] of [
      ["token", { ...base, token: "fixture-B" }],
      ["base path", { ...base, url: "http://fixture.invalid:8123/team-b" }],
      ["scheme", { ...base, url: "https://fixture.invalid:8123/team-a" }],
    ] as const) {
      it(`${state}: ${change} must handshake before joining an owner`, async () => {
        const h = harness();
        try {
          const first = h.registry.connect({
            requestId: "one",
            target: base,
            remoteAssets: {},
            workspacePath: "/work",
          });
          void first.catch(() => undefined);
          if (state === "online") {
            h.release();
            await first;
          }
          const second = h.registry.connect({
            requestId: "two",
            target,
            remoteAssets: {},
            workspacePath: "/work",
          });
          const settled = second.catch((error: unknown) => error);
          const callCount = h.calls.length;
          h.release();
          const descriptor = await first;
          const result = await settled;
          expect(callCount).toBe(2);
          if (change === "token") {
            expect(result).toMatchObject({ code: "source-server-identity-change-pending" });
          } else {
            expect(result).toMatchObject({ sourceServerId: "source-other-endpoint" });
            const secondDescriptor = await second;
            expect(
              h.registry.resolveScopedServices({
                kind: "remote",
                remoteSessionId: secondDescriptor.remoteSessionId,
                workspacePath: "/work",
                workspaceIdentity: secondDescriptor.workspaceIdentity!,
              }),
            ).toEqual({ id: "fixture-A", endpoint: target.url });
          }
          expect(
            h.registry.resolveScopedServices({
              kind: "remote",
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: "/work",
              workspaceIdentity: descriptor.workspaceIdentity!,
            }),
          ).toEqual({ id: "fixture-A", endpoint: base.url });
          expect(JSON.stringify(h.registry.listSessions())).not.toContain("fixture-A");
        } finally {
          h.release();
          await h.registry.dispose();
        }
      });
    }
  }
});

describe("Source primary logical identities (auditor A2)", () => {
  it("rejects direct-server descriptors without a handshake id even with an advertised id/hint", async () => {
    const registry = createWindowRemoteConnectionRegistry({
      createId: () => "missing-id",
      connect: async () => ({ services: {}, dispose() {} }),
    });
    try {
      await expect(
        registry.connect({
          requestId: "missing-id",
          target: { ...base, serverId: "advertised" },
          remoteAssets: {},
          workspacePath: "/work",
          workspaceIdentity: "remote:server:advertised:/work",
        }),
      ).rejects.toMatchObject({ code: "source-server-identity-change-pending" });
      expect(registry.listSessions()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });

  for (const target of [
    { kind: "ssh" as const, host: "fixture.invalid", username: "alice" },
    { kind: "wsl" as const, distro: "Fixture", user: "alice" },
    { kind: "docker" as const, container: "fixture-a" },
  ]) {
    it(`${target.kind}: rejects a cross-authority hint before publishing or mutating scope`, async () => {
      const h = harness();
      h.release();
      try {
        const identity = buildRemoteWorkspaceIdentity("/work", target);
        const descriptor = await h.registry.connect({
          requestId: "valid",
          target,
          remoteAssets: {},
          workspacePath: "/work",
          workspaceIdentity: identity,
        });
        const otherTarget =
          target.kind === "ssh"
            ? { ...target, username: "bob" }
            : target.kind === "wsl"
              ? { ...target, user: "bob" }
              : { ...target, container: "fixture-b" };
        const invalid = buildRemoteWorkspaceIdentity("/work", otherTarget);
        expect(() =>
          h.registry.bindWorkspaceContext({
            remoteSessionId: descriptor.remoteSessionId,
            workspacePath: "/work",
            workspaceIdentity: invalid,
          }),
        ).toThrowError(expect.objectContaining({ code: "source-server-identity-change-pending" }));
        expect(h.registry.getSession(descriptor.remoteSessionId)?.workspaceIdentity).toBe(identity);
        await expect(
          h.registry.connect({
            requestId: "invalid",
            target,
            remoteAssets: {},
            workspacePath: "/work",
            workspaceIdentity: invalid,
          }),
        ).rejects.toMatchObject({ code: "source-server-identity-change-pending" });
        expect(h.registry.listSessions()).toHaveLength(1);
      } finally {
        await h.registry.dispose();
      }
    });
  }
  it("does not accept a legacy hint without the handshake authorization proof", async () => {
    const target = { kind: "ssh" as const, host: "fixture.invalid", username: "alice" };
    const registry = createWindowRemoteConnectionRegistry({
      createId: () => "no-proof",
      connect: async () => ({ services: {}, sourceServerId: "source-real", dispose() {} }),
    });
    try {
      await expect(
        registry.connect({
          requestId: "no-proof",
          target,
          remoteAssets: {},
          workspacePath: "/work",
          workspaceIdentity: buildRemoteWorkspaceIdentity("/work", target),
        }),
      ).rejects.toMatchObject({ code: "source-server-identity-change-pending" });
      expect(registry.listSessions()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });

  it("three validated legacy transports share Source owner, not execution/history/attachment keys", async () => {
    const h = harness();
    h.release();
    try {
      // 首个 transport owner 选 WSL，才能同时验证其既有 execution runtime release 的精确 key。
      const targets: RemoteTarget[] = [
        { kind: "wsl", distro: "Fixture", user: "alice" },
        { kind: "wsl", distro: "Fixture", user: "bob" },
        { kind: "ssh", host: "fixture.invalid", username: "alice" },
        { kind: "ssh", host: "fixture.invalid", username: "bob" },
        { kind: "docker", container: "fixture-a" },
        { kind: "docker", container: "fixture-b" },
      ];
      for (const [index, target] of targets.entries()) {
        const identity = buildRemoteWorkspaceIdentity("/work", target);
        const descriptor = await h.registry.connect({
          requestId: `legacy-${index}`,
          target,
          remoteAssets: {},
          workspacePath: "/work",
          workspaceIdentity: identity,
        });
        expect(descriptor.workspaceIdentity).toBe(identity);
        await h.registry.bindWorkspaceContext({
          remoteSessionId: descriptor.remoteSessionId,
          workspacePath: "/work",
          workspaceIdentity: "remote:server:source-real:/work",
        });
        expect(h.registry.getSession(descriptor.remoteSessionId)?.workspaceIdentity).toBe(identity);
        expect(
          h.registry.findSessionForWorkspace({
            workspacePath: "/work",
            workspaceIdentity: identity,
          })?.remoteSessionId,
        ).toBe(descriptor.remoteSessionId);
        expect(
          h.registry.resolveScopedServices({
            kind: "remote",
            remoteSessionId: descriptor.remoteSessionId,
            workspacePath: "/work",
            workspaceIdentity: identity,
          }),
        ).toEqual({ id: "shared", endpoint: "transport" });
      }
      expect(h.calls).toHaveLength(6);
      expect(
        new Set(h.registry.listSessions().map((session) => session.workspaceIdentity)).size,
      ).toBe(6);
      expect(h.registry.getStats()).toMatchObject({
        sourceCount: 1,
        connectionCount: 1,
        logicalSessionCount: 6,
      });
      const canonical = "remote:server:source-real:/work";
      expect(
        h.registry.findSessionForWorkspace({
          workspacePath: "/work",
          workspaceIdentity: canonical,
        }),
      ).toBeNull();
      const fresh = await h.registry.connect({
        requestId: "new",
        target: targets[0]!,
        remoteAssets: {},
        workspacePath: "/work",
      });
      expect(fresh.workspaceIdentity).toBe(canonical);
      expect(
        h.registry.findSessionForWorkspace({ workspacePath: "/work", workspaceIdentity: canonical })
          ?.remoteSessionId,
      ).toBe(fresh.remoteSessionId);
      for (const session of h.registry.listSessions()) {
        if (session.remoteSessionId !== fresh.remoteSessionId)
          await h.registry.disposeSession(session.remoteSessionId);
      }
      expect(new Set(h.released.map((context) => context.workspaceIdentity))).toEqual(
        new Set(targets.map((target) => buildRemoteWorkspaceIdentity("/work", target))),
      );
      expect(h.registry.getSession(fresh.remoteSessionId)?.workspaceIdentity).toBe(canonical);
    } finally {
      await h.registry.dispose();
    }
  });

  it("does not blindly preserve an unverified direct-server provisional hint", async () => {
    const h = harness();
    h.release();
    try {
      await expect(
        h.registry.connect({
          requestId: "unverified",
          target: base,
          remoteAssets: {},
          workspacePath: "/work",
          workspaceIdentity: "remote:server:old-display-name:/work",
        }),
      ).rejects.toMatchObject({ code: "source-server-identity-change-pending" });
      expect(h.registry.listSessions()).toEqual([]);
    } finally {
      await h.registry.dispose();
    }
  });
});
