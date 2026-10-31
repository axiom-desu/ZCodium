import { describe, expect, it } from "vitest";
import {
  compareCompatibilityVersions,
  connectionProfileSchema,
  createCompatibilityManifest,
  evaluateSourceServerCompatibility,
  getSourceServerUpdateTarget,
  isSameSourceServerUpdateTarget,
  sourceServerReleaseDescriptorSchema,
  sourceServerUpdateRequestSchema,
} from "./contract.js";
import {
  serverRemoteAnonymousInfoSchema,
  serverRemoteInfoOutputSchema,
  serverRemoteInfoSchema,
} from "../server-remote.js";

const profileId = "2a7b4d76-0d8d-4f1e-a2b8-9f0f0a1b2c3d";
const sourceServerId = "7f3c2b1a-4d5e-4f60-8a9b-0c1d2e3f4a5b";

describe("source-server contracts", () => {
  it("parses profiles without plaintext secrets and keeps credential keys only", () => {
    const profile = connectionProfileSchema.parse({
      profileId,
      sourceServerId,
      transport: "ssh",
      target: {
        kind: "ssh",
        host: "dev.example.test",
        username: "developer",
        passwordCredentialKey: "connection-profile:example:password",
      },
      createdAt: 1,
    });
    expect(profile.lifecycleState).toBe("active");
    expect(
      connectionProfileSchema.safeParse({
        ...profile,
        target: { ...profile.target, password: "secret" },
      }).success,
    ).toBe(false);
  });

  it("normalizes the update target to non-secret execution identity", () => {
    const ssh = { kind: "ssh" as const, host: "Dev.Example.Test", username: "developer" };
    const sameSsh = { kind: "ssh" as const, host: "dev.example.test", username: "developer" };
    expect(getSourceServerUpdateTarget(ssh)).toEqual({
      kind: "ssh",
      host: "dev.example.test",
      port: 22,
      username: "developer",
    });
    expect(isSameSourceServerUpdateTarget(ssh, sameSsh)).toBe(true);
    expect(
      isSameSourceServerUpdateTarget(
        { kind: "wsl", distro: "Ubuntu", user: undefined },
        { kind: "wsl", distro: "Ubuntu", user: undefined },
      ),
    ).toBe(false);
    expect(
      sourceServerUpdateRequestSchema.parse({
        profileId,
        force: true,
        expectedTarget: getSourceServerUpdateTarget(ssh),
      }),
    ).toMatchObject({ force: true });
  });

  it("evaluates explicit compatibility versions without a missing-version fallback", () => {
    expect(compareCompatibilityVersions("3.16.2", "3.16.0")).toBeGreaterThan(0);
    expect(compareCompatibilityVersions("3.16.2-beta.1", "3.16.2")).toBeLessThan(0);
    const compatible = evaluateSourceServerCompatibility(
      createCompatibilityManifest("3.16.2", "3.15.0"),
      createCompatibilityManifest("3.15.1", "3.15.0"),
    );
    expect(compatible).toMatchObject({
      compatible: true,
      updateAvailable: true,
      newerEndpoint: "controller",
      newerVersion: "3.16.2",
      olderVersion: "3.15.1",
    });
    const required = evaluateSourceServerCompatibility(
      createCompatibilityManifest("3.16.2", "3.16.2"),
      createCompatibilityManifest("3.15.1", "3.16.0"),
    );
    expect(required).toMatchObject({
      compatible: false,
      upgradeTarget: "server",
      requiredMinimumVersion: "3.16.2",
    });
  });

  it("validates release descriptors, archive names and safe relative URLs", () => {
    const archive = {
      target: "linux-x64" as const,
      version: "3.16.2",
      fileName: "zcode-server-linux-x64.tar.gz",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      urls: ["releases/3.16.2/zcode-server-linux-x64.tar.gz"],
    };
    expect(
      sourceServerReleaseDescriptorSchema.parse({
        schemaVersion: 1,
        version: "3.16.2",
        archives: [archive],
      }).archives,
    ).toHaveLength(1);
    expect(
      sourceServerReleaseDescriptorSchema.safeParse({
        schemaVersion: 1,
        version: "3.16.2",
        archives: [{ ...archive, fileName: "other.tar.gz" }],
      }).success,
    ).toBe(false);
    expect(
      sourceServerReleaseDescriptorSchema.safeParse({
        schemaVersion: 1,
        version: "3.16.2",
        archives: [{ ...archive, urls: ["../escape.tar.gz"] }],
      }).success,
    ).toBe(false);
    expect(
      sourceServerReleaseDescriptorSchema.safeParse({
        schemaVersion: 1,
        version: "3.16.2",
        archives: [archive, archive],
      }).success,
    ).toBe(false);
  });
});

describe("server-remote optional wire schema", () => {
  const info = {
    serverId: "source-1",
    version: "3.16.2",
    protocolVersion: 1,
    authRequired: true,
    workspaces: [{ path: "/work/project", workspaceIdentity: "remote:server:x:/work/project" }],
    compatibility: { schemaVersion: 1, productVersion: "3.16.2", minCompatibleVersion: "3.16.0" },
    migration: { failedPathCount: 2 },
    identity: { osUser: "dev", hostname: "dev-box" },
    capabilities: { desktopContinuous: true, websocketRpc: true, virtualProjects: true },
  };

  it("round-trips optional compatibility, migration, identity and capability fields", () => {
    expect(serverRemoteInfoSchema.parse(info)).toEqual(info);
    expect(serverRemoteInfoOutputSchema.parse(info)).toEqual(info);
  });

  it("keeps old payloads valid and rejects unknown output fields", () => {
    const legacy = {
      serverId: "source-1",
      version: "3.15.1",
      protocolVersion: 1,
      authRequired: false,
      workspaces: [],
      capabilities: { desktopContinuous: true, websocketRpc: true },
    };
    expect(serverRemoteInfoSchema.parse(legacy)).toEqual(legacy);
    expect(serverRemoteInfoOutputSchema.safeParse({ ...legacy, unexpected: true }).success).toBe(
      false,
    );
  });

  it("limits anonymous descriptions to non-sensitive version and compatibility", () => {
    const anonymous = serverRemoteAnonymousInfoSchema.parse({
      version: "3.16.2",
      protocolVersion: 1,
      authRequired: true,
      compatibility: { schemaVersion: 1, productVersion: "3.16.2", minCompatibleVersion: "3.16.0" },
      serverId: "must-be-stripped",
      workspaces: [{ path: "/secret" }],
    });
    expect(anonymous).toEqual({
      version: "3.16.2",
      protocolVersion: 1,
      authRequired: true,
      compatibility: { schemaVersion: 1, productVersion: "3.16.2", minCompatibleVersion: "3.16.0" },
    });
  });
});
