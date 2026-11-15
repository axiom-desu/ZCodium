import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExtensionsService } from "./service.js";

/**
 * 授权文件写入失败时不得发布成功；撤销的运行时效果先于持久化（fail closed），
 * 但持久化/投影保留上一次成功状态。
 */
describe("extension service grant persistence", () => {
  it("does not publish a grant when the grants file cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-ext-service-"));
    const pluginDir = join(root, "extensions");
    await writeManifest(pluginDir, "alpha");
    const grantsFilePath = join(root, "grants.json");
    // 目录占住 grants.json，让 rename 失败；load 读取失败按空记录处理。
    await mkdir(grantsFilePath, { recursive: true });
    const supervisor = fakeSupervisor();
    const service = createExtensionsService({
      grantsFilePath,
      pluginDir,
      workspaceIdentity: () => "local:/tmp/ws",
      processSupervisor: supervisor,
      readSettings: async () => ({ locale: "en-US" }),
    });
    try {
      const before = await service.getSnapshot();
      expect(before.plugins[0]?.status).toBe("needs-consent");
      await expect(
        service.grant({ pluginId: "alpha", grants: ["projects.read"] }),
      ).rejects.toThrow();
      const after = await service.getSnapshot();
      expect(after.plugins[0]?.status).toBe("needs-consent");
      expect(after.plugins[0]?.granted).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it("invalidates the runtime on revoke but keeps the last persisted projection on write failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-ext-service-"));
    const pluginDir = join(root, "extensions");
    await writeManifest(pluginDir, "alpha");
    const grantsFilePath = join(root, "grants.json");
    await writeFile(
      grantsFilePath,
      JSON.stringify({
        v: 1,
        records: [
          {
            pluginId: "alpha",
            name: "alpha extension",
            grants: ["projects.read"],
            consentVersion: "1.0.0",
            consentedAt: 1,
          },
        ],
      }),
    );
    const supervisor = fakeSupervisor();
    const service = createExtensionsService({
      grantsFilePath,
      pluginDir,
      workspaceIdentity: () => "local:/tmp/ws",
      processSupervisor: supervisor,
      readSettings: async () => ({ locale: "en-US" }),
    });
    try {
      const started = await service.start();
      expect(started.phase, started.error ?? "").toBe("ready");
      expect(supervisor.starts).toHaveLength(1);
      const token = supervisor.starts[0]!.token;
      const endpoint = supervisor.starts[0]!.endpoint;

      // 用目录替换授权文件，后续 save 失败。
      await rm(grantsFilePath);
      await mkdir(grantsFilePath, { recursive: true });
      await expect(service.revoke("alpha")).rejects.toThrow();

      const snapshot = await service.getSnapshot();
      expect(snapshot.plugins[0]?.status).toBe("granted");
      expect(supervisor.stopped).toEqual(["alpha"]);
      const response = await fetch(`${endpoint}/capability`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          v: 1,
          generation: snapshot.generation,
          workspaceIdentity: "local:/tmp/ws",
          pluginId: "alpha",
          capabilityId: "settings.get",
        }),
      });
      // 运行时已 fail closed：token 在撤销时失效。
      expect(response.status).toBe(401);
    } finally {
      await service.dispose().catch(() => {});
    }
  });
});

function fakeSupervisor() {
  const starts: Array<{
    token: string;
    endpoint: string;
    pluginId: string;
    generation: number;
  }> = [];
  const stopped: string[] = [];
  return {
    starts,
    stopped,
    async start(input: (typeof starts)[number]) {
      starts.push({ ...input });
      return { pid: 1 };
    },
    async stop() {},
    async stopPlugin(_generation: number, pluginId: string) {
      stopped.push(pluginId);
    },
  };
}

async function writeManifest(pluginDir: string, id: string): Promise<void> {
  await mkdir(join(pluginDir, id), { recursive: true });
  await writeFile(
    join(pluginDir, id, "extension.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: `${id} extension`,
      version: "1.0.0",
      main: "extension.mjs",
      capabilities: ["settings.get", "projects.list"],
      grants: ["projects.read"],
      protocols: { projects: 1 },
      slots: [],
    }),
  );
  await writeFile(join(pluginDir, id, "extension.mjs"), "export function activate() {}\n");
}
