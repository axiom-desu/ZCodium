import { describe, expect, it } from "vitest";
import { resolveBoundRemoteWorkspaceIdentity } from "./remoteWorkspaceDescriptorIdentity.js";

describe("Main forwards Host Source identity without rewriting", () => {
  it("preserves the Host exact legacy descriptor on same-path bind", () => {
    expect(
      resolveBoundRemoteWorkspaceIdentity({
        descriptor: {
          sourceServerId: "source-real",
          workspacePath: "/srv/app",
          workspaceIdentity: "remote:ssh:dev.example:22:dev:/srv/app",
          target: { kind: "ssh", host: "dev.example", username: "dev" },
        },
        workspacePath: "/srv/app",
        rendererWorkspaceIdentity: "remote:server:source-real:/srv/app",
      }),
    ).toBe("remote:ssh:dev.example:22:dev:/srv/app");
  });

  it("moves a verified legacy descriptor along the same transport, not to canonical", () => {
    expect(
      resolveBoundRemoteWorkspaceIdentity({
        descriptor: {
          sourceServerId: "source-real",
          workspacePath: "/old",
          workspaceIdentity: "remote:wsl:Fixture:dev:/old",
          target: { kind: "wsl", distro: "Fixture", user: "dev" },
        },
        workspacePath: "/new",
      }),
    ).toBe("remote:wsl:Fixture:dev:/new");
  });
  it("uses the descriptor handshake id even when the renderer advertises another id", () => {
    const identity = resolveBoundRemoteWorkspaceIdentity({
      descriptor: {
        sourceServerId: "source-real",
        target: {
          kind: "server",
          url: "https://studio.example",
          serverId: "source-real",
        },
      },
      workspacePath: "/srv/app",
      rendererWorkspaceIdentity: "remote:server:attacker-declared:/srv/app",
    });

    expect(identity).toBe("remote:server:source-real:/srv/app");
  });

  it("keeps renderer identity for non-Source transports", () => {
    const identity = resolveBoundRemoteWorkspaceIdentity({
      descriptor: {
        target: { kind: "ssh", host: "dev.example", username: "dev" },
      },
      workspacePath: "/srv/app",
      rendererWorkspaceIdentity: "remote:ssh:dev.example:22:dev:/srv/app",
    });

    expect(identity).toBe("remote:ssh:dev.example:22:dev:/srv/app");
  });

  it("derives non-Source identity from target when renderer has none", () => {
    const identity = resolveBoundRemoteWorkspaceIdentity({
      descriptor: {
        target: { kind: "ssh", host: "dev.example", username: "dev" },
      },
      workspacePath: "/srv/app",
    });

    expect(identity).toBe("remote:ssh:dev.example:22:dev:/srv/app");
  });
});
