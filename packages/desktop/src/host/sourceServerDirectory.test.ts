import { describe, expect, it } from "vitest";
import { appSettingsSchema, type AppSettings } from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import { SourceServerDirectory } from "./sourceServerDirectory.js";

interface Harness {
  directory: SourceServerDirectory;
  settings: AppSettings;
  credentials: Map<string, string>;
  updates: Partial<AppSettings>[];
  failNextUpdate: (error: Error) => void;
  onBeforeUpdate: (hook: ((patch: Partial<AppSettings>) => void) | undefined) => void;
}

function createHarness(initial: Partial<AppSettings> = {}): Harness {
  let settings = appSettingsSchema.parse(initial) as AppSettings;
  const credentials = new Map<string, string>();
  const updates: Partial<AppSettings>[] = [];
  let nextFailure: Error | undefined;
  let beforeUpdate: ((patch: Partial<AppSettings>) => void) | undefined;
  let profileCounter = 0;
  const settingService: ISettingService = {
    async get() {
      return structuredClone(settings);
    },
    async update(patch) {
      if (nextFailure) {
        const error = nextFailure;
        nextFailure = undefined;
        throw error;
      }
      beforeUpdate?.(patch);
      updates.push(structuredClone(patch));
      settings = { ...settings, ...structuredClone(patch) };
    },
    async updateDataBaseDir() {},
    async ensureDefaultProject() {
      return { path: "/home", created: false };
    },
  };
  const credentialService: ICredentialService = {
    async load(key) {
      return credentials.get(key) ?? null;
    },
    async save(key, value) {
      credentials.set(key, value);
    },
    async delete(key) {
      credentials.delete(key);
    },
  };
  const directory = new SourceServerDirectory({
    settingService,
    credentialService,
    createProfileId: () => `profile-${++profileCounter}`,
    now: () => 1_000,
  });
  const harness: Harness = {
    directory,
    get settings() {
      return settings;
    },
    credentials,
    updates,
    failNextUpdate(error) {
      nextFailure = error;
    },
    onBeforeUpdate(hook) {
      beforeUpdate = hook;
    },
  };
  return harness;
}

function legacyEntry(input: {
  workspacePath: string;
  workspaceIdentity: string;
  username: string;
  passwordCredentialKey: string;
  lastOpenedAt: number;
}) {
  return {
    kind: "remote" as const,
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    target: {
      kind: "ssh" as const,
      host: "example.test",
      port: 22,
      username: input.username,
      passwordCredentialKey: input.passwordCredentialKey,
    },
    lastOpenedAt: input.lastOpenedAt,
    lastConnectionStatus: "connected" as const,
  };
}

describe("SourceServerDirectory migration and credential ordering", () => {
  it("keeps two legacy identities on the same path distinct and copies credentials before settings commit", async () => {
    const harness = createHarness({
      lastWorkspaceSession: [
        legacyEntry({
          workspacePath: "/work",
          workspaceIdentity: "remote:ssh:alice@example.test:22:/work",
          username: "alice",
          passwordCredentialKey: "legacy-alice",
          lastOpenedAt: 20,
        }),
        legacyEntry({
          workspacePath: "/work",
          workspaceIdentity: "remote:ssh:bob@example.test:22:/work",
          username: "bob",
          passwordCredentialKey: "legacy-bob",
          lastOpenedAt: 10,
        }),
      ],
    });
    harness.credentials.set("legacy-alice", "alice-secret");
    harness.credentials.set("legacy-bob", "bob-secret");

    let observedBeforeCommit: { destinations: string[]; legacyStillPresent: boolean } | undefined;
    // settings 提交前确认新 key 已写入、旧 key 尚未删除；提交成功后才允许清理旧值。
    harness.onBeforeUpdate(() => {
      const destinations = [...harness.credentials.keys()].filter((key) =>
        key.startsWith("source-server:"),
      );
      observedBeforeCommit = {
        destinations,
        legacyStillPresent:
          harness.credentials.has("legacy-alice") && harness.credentials.has("legacy-bob"),
      };
    });

    await harness.directory.initialize();

    expect(observedBeforeCommit?.destinations).toHaveLength(2);
    expect(observedBeforeCommit?.legacyStillPresent).toBe(true);
    expect(harness.settings.connectionProfiles).toHaveLength(2);
    expect(harness.settings.sourceServerWorkspaceHistory).toHaveLength(2);
    expect(
      new Set(
        harness.settings.sourceServerWorkspaceHistory?.map(
          (entry) => entry.legacyWorkspaceIdentity,
        ),
      ),
    ).toEqual(
      new Set(["remote:ssh:alice@example.test:22:/work", "remote:ssh:bob@example.test:22:/work"]),
    );
    expect(
      new Set(harness.settings.sourceServerWorkspaceHistory?.map((entry) => entry.profileId)).size,
    ).toBe(2);
    // secret 只在新 credential key 下，不进入 setting.json。
    const serialized = JSON.stringify(harness.settings);
    expect(serialized).not.toContain("alice-secret");
    expect(serialized).not.toContain("bob-secret");
    // 旧 credential key 名称仍随 legacy lastWorkspaceSession 保留供回滚；值只在 credential store。
    expect(harness.credentials.has("legacy-alice")).toBe(true);
  });

  it("restores newly written credentials when settings commit fails during migration", async () => {
    const harness = createHarness({
      lastWorkspaceSession: [
        legacyEntry({
          workspacePath: "/work",
          workspaceIdentity: "remote:ssh:alice@example.test:22:/work",
          username: "alice",
          passwordCredentialKey: "legacy-alice",
          lastOpenedAt: 10,
        }),
      ],
    });
    harness.credentials.set("legacy-alice", "alice-secret");
    harness.failNextUpdate(new Error("settings write failed"));

    await expect(harness.directory.initialize()).rejects.toThrow(/settings write failed/u);

    expect(harness.settings.sourceServerDirectoryMigrationVersion).toBeUndefined();
    expect(harness.settings.connectionProfiles).toEqual([]);
    expect(harness.credentials.get("legacy-alice")).toBe("alice-secret");
    expect(
      [...harness.credentials.keys()].filter((key) => key.startsWith("source-server:")),
    ).toEqual([]);
  });

  it("rolls back a new profile credential when the profile settings commit fails", async () => {
    const harness = createHarness({ sourceServerDirectoryMigrationVersion: 1 });
    harness.failNextUpdate(new Error("settings write failed"));

    await expect(
      harness.directory.ensureProfile({
        kind: "ssh",
        host: "example.test",
        username: "alice",
        password: "new-secret",
      }),
    ).rejects.toThrow(/settings write failed/u);

    expect(harness.settings.connectionProfiles).toEqual([]);
    expect([...harness.credentials.keys()]).toEqual([]);
  });

  it("keeps the old profile and credentials usable when profile removal cannot be committed", async () => {
    const harness = createHarness({ sourceServerDirectoryMigrationVersion: 1 });
    const profile = await harness.directory.ensureProfile({
      kind: "ssh",
      host: "example.test",
      username: "alice",
      password: "secret",
    });
    const passwordKey =
      profile.target.kind === "ssh" ? profile.target.passwordCredentialKey : undefined;
    expect(passwordKey).toBeDefined();
    harness.failNextUpdate(new Error("settings write failed"));

    await expect(harness.directory.removeProfile(profile.profileId)).rejects.toThrow(
      /settings write failed/u,
    );

    expect(harness.settings.connectionProfiles).toEqual([profile]);
    expect(harness.credentials.get(passwordKey!)).toBe("secret");
    await expect(harness.directory.resolveProfileTarget(profile)).resolves.toMatchObject({
      kind: "ssh",
      host: "example.test",
      username: "alice",
      password: "secret",
    });
  });
});
