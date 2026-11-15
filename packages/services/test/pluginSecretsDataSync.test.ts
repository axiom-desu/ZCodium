// D1 插件数据同步的敏感值边界：真实 inline 导出/导入服务，不是只测 pickPortablePluginOptions。
// legacy 明文（尚未迁移进私有文件）与私有 plugin-secrets.json 都不能进入同步 items/归档；
// 导入端也不能把远端 payload 带来的敏感键写回 config.json。全部使用临时 HOME。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInlinePluginDataSyncMethods } from "#src/data-sync/inlinePluginDataSync.js";
import { createPluginSyncArchive } from "#src/plugin-sync/pluginSyncArchive.js";
import { ZCODE_PLUGIN_MANIFEST_DIR_NAME, ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

const PLUGIN_NAME = "secret-plugin";
const PLUGIN_ID = `${PLUGIN_NAME}@inline`;
const LEGACY_SECRET = "legacy-plaintext-secret";
const PRIVATE_SECRET = "private-store-secret";
const REMOTE_SECRET = "remote-payload-secret";

async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcode-plugin-secrets-sync-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    await rm(home, { recursive: true, force: true });
  }
}

function userDataPath(home: string): string {
  return join(home, ZCODE_USER_DATA_DIR_NAME);
}

function configPath(home: string): string {
  return join(userDataPath(home), "cli", "config.json");
}

function secretsPath(home: string): string {
  return join(userDataPath(home), "cli", "plugin-secrets.json");
}

function pluginRoot(home: string): string {
  return join(userDataPath(home), "plugins", PLUGIN_NAME);
}

function manifest(): Record<string, unknown> {
  return {
    name: PLUGIN_NAME,
    version: "1.0.0",
    userConfig: {
      token: { sensitive: true, type: "string" },
      region: { type: "string" },
    },
    mcpServers: {},
  };
}

async function writeFileWithDirs(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

test("inline 导出不带走 legacy 明文、私有 secret 或 plugin-secrets.json", async () => {
  await withTempHome(async (home) => {
    const root = pluginRoot(home);
    await writeFileWithDirs(
      join(root, ZCODE_PLUGIN_MANIFEST_DIR_NAME, "plugin.json"),
      JSON.stringify(manifest()),
    );
    await writeFile(join(root, "content.txt"), "exported content");
    await writeFileWithDirs(
      configPath(home),
      JSON.stringify({
        plugins: {
          dirs: [root],
          // legacy 明文尚未迁移：导出端仍必须按 manifest schema 丢掉 token。
          options: { [PLUGIN_ID]: { token: LEGACY_SECRET, region: "eu" } },
        },
      }),
    );
    await writeFileWithDirs(
      secretsPath(home),
      JSON.stringify({
        version: 1,
        user: { [PLUGIN_ID]: { token: PRIVATE_SECRET } },
        workspaces: {},
      }),
    );

    const service = createInlinePluginDataSyncMethods({ maxItemBytes: 10 * 1024 * 1024 });
    const exported = await service.exportSyncItems({ keys: [PLUGIN_ID] });

    assert.deepEqual(exported.items, [
      {
        key: PLUGIN_ID,
        pluginId: PLUGIN_ID,
        directoryName: PLUGIN_NAME,
        enabled: true,
        options: { region: "eu" },
      },
    ]);
    const payloadText = JSON.stringify(exported.items);
    assert.equal(payloadText.includes(LEGACY_SECRET), false);
    assert.equal(payloadText.includes(PRIVATE_SECRET), false);
    const archiveText = exported.archive.toString("latin1");
    assert.equal(archiveText.includes("plugin-secrets.json"), false);
    assert.equal(archiveText.includes(LEGACY_SECRET), false);
    // 私有文件本身仍留在源端，导出只是不携带。
    assert.deepEqual((await readJson<{ user: unknown }>(secretsPath(home))).user, {
      [PLUGIN_ID]: { token: PRIVATE_SECRET },
    });
  });
});

test("inline 导入拒绝把远端 payload 的敏感键写回 config.json", async () => {
  await withTempHome(async (home) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "zcode-plugin-source-"));
    try {
      const sourceManifest = join(sourceRoot, ZCODE_PLUGIN_MANIFEST_DIR_NAME, "plugin.json");
      await writeFileWithDirs(sourceManifest, JSON.stringify(manifest()));
      const archive = await createPluginSyncArchive({
        entries: [
          {
            sourcePath: sourceManifest,
            archivePath: `${PLUGIN_NAME}/${ZCODE_PLUGIN_MANIFEST_DIR_NAME}/plugin.json`,
          },
        ],
        metadata: {
          plugins: [{ name: PLUGIN_NAME, pluginId: PLUGIN_ID, directoryName: PLUGIN_NAME }],
        },
      });
      await writeFileWithDirs(
        configPath(home),
        JSON.stringify({ plugins: { dirs: [], options: {} } }),
      );

      const service = createInlinePluginDataSyncMethods({ maxItemBytes: 10 * 1024 * 1024 });
      const result = await service.importSyncItems({
        payload: {
          archive,
          sourceHomeDir: home,
          items: [
            {
              key: PLUGIN_ID,
              pluginId: PLUGIN_ID,
              directoryName: PLUGIN_NAME,
              enabled: true,
              // 远端 payload 故意携带敏感键：目标端按 manifest 再筛一次。
              options: { token: REMOTE_SECRET, region: "eu" },
            },
          ],
        },
        items: [{ key: PLUGIN_ID, mode: "createOnly" }],
      });
      assert.equal(result.results[0]?.status, "created");

      const configText = await readFile(configPath(home), "utf8");
      assert.equal(configText.includes(REMOTE_SECRET), false);
      assert.deepEqual(
        (await readJson<{ plugins: { options: unknown } }>(configPath(home))).plugins.options,
        {
          [PLUGIN_ID]: { region: "eu" },
        },
      );
      // 导入不写私有文件：同步不能凭空生成 secret owner。
      await assert.rejects(stat(secretsPath(home)));
    } finally {
      await rm(sourceRoot, { force: true, recursive: true });
    }
  });
});
