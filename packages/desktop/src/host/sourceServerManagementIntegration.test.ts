import { describe, expect, it } from "vitest";
import { appSettingsSchema, type AppSettings } from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import { SourceServerDirectory } from "./sourceServerDirectory.js";
import { createSourceServerManagementService } from "./sourceServerManagementService.js";

function createStore() {
  let settings = appSettingsSchema.parse({}) as AppSettings;
  const credentials = new Map<string, string>();
  const settingService: ISettingService = {
    async get() {
      return structuredClone(settings);
    },
    async update(patch) {
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
  return {
    directory: new SourceServerDirectory({
      settingService,
      credentialService,
      createProfileId: () => "22222222-2222-4222-8222-222222222222",
      now: () => 1_000,
    }),
    credentials,
    settings: () => structuredClone(settings),
  };
}

describe("Source 管理服务 + 临时 settings/credential", () => {
  it("真实 directory 保存凭据引用，连接时只从 credential port 解析，快照不含明文", async () => {
    const store = createStore();
    let connectedTarget: unknown;
    const service = createSourceServerManagementService({
      directory: store.directory,
      runtime: {
        async connect(input) {
          connectedTarget = input.target;
          return { sourceServerId: "11111111-1111-4111-8111-111111111111", version: "3.16.2" };
        },
        async update() {
          return {};
        },
        async disconnect() {},
        isOnline: () => false,
        currentVersion: () => "3.16.2",
      },
    });

    const snapshot = await service.createProfile({
      target: {
        kind: "ssh",
        host: "Host.Example",
        port: 22,
        username: "dev",
        password: "temp-password",
      },
      profileDisplayName: "Build box",
    });

    expect(JSON.stringify(snapshot)).not.toContain("temp-password");
    expect(JSON.stringify(store.settings())).not.toContain("temp-password");
    expect([...store.credentials.values()]).toContain("temp-password");

    await service.connectProfile("22222222-2222-4222-8222-222222222222", {
      confirmSourceServerInstall: true,
      expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
    });
    expect(connectedTarget).toMatchObject({ host: "host.example", password: "temp-password" });
    service.dispose();
  });
});
