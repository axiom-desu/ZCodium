import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createDeviceSyncStateService } from "#src/data-sync/deviceSyncStateService.js";
import { createMcpDataSyncMethods } from "#src/data-sync/mcpDataSync.js";
import { createCommandDataSyncMethods } from "#src/data-sync/commandDataSync.js";
import { createUserConfigSyncService } from "#src/data-sync/userConfigSyncService.js";
import { createInlinePluginDataSyncMethods } from "#src/data-sync/inlinePluginDataSync.js";
import { createPluginSyncArchive } from "#src/plugin-sync/pluginSyncArchive.js";
import {
  hashDirectoryContent,
  isPathWithin,
  scanDirectoryContent,
} from "#src/data-sync/directoryContent.js";
import { stableStringify } from "#src/data-sync/syncUtils.js";
import { updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import { ZCODE_PLUGIN_MANIFEST_DIR_NAME, ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";

/**
 * 数据同步服务回归：CAS 覆盖、临时 HOME 下的路径/软链/唯一目录、设备同步状态写入串行。
 * 全部使用临时目录与临时 HOME，不读真实用户配置、不连远端。
 */

/** 每个用例独立 HOME：resolveUserHomeDir 每次读取 process.env，隔离真实配置。 */
async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcodium-datasync-"));
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

function cliConfigPath(home: string): string {
  return join(home, ZCODE_USER_DATA_DIR_NAME, "cli", "config.json");
}

async function writeCliConfig(home: string, config: Record<string, unknown>): Promise<string> {
  const path = cliConfigPath(home);
  await mkdir(join(home, ZCODE_USER_DATA_DIR_NAME, "cli"), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return path;
}

function mcpHash(config: Record<string, unknown>): string {
  const comparable = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== "enabled" && key !== "enable"),
  );
  return createHash("sha256").update(stableStringify(comparable)).digest("hex");
}

test("mcp import overwrite requires the freshly computed target hash (CAS)", async () => {
  await withTempHome(async (home) => {
    const path = await writeCliConfig(home, {
      mcp: { servers: { alpha: { command: "alpha-bin" } } },
    });
    const service = createMcpDataSyncMethods();

    const listed = await service.listSyncItems();
    assert.deepEqual(
      listed.items.map((item) => item.key),
      ["alpha"],
    );

    const stale = await service.importSyncItems({
      payload: {
        sourceHomeDir: home,
        items: [
          {
            key: "alpha",
            name: "alpha",
            config: { command: "new-bin" },
            enabled: true,
          },
        ],
      },
      items: [{ key: "alpha", mode: "overwrite", expectedTargetHash: "stale-hash" }],
    });
    assert.deepEqual(stale.results, [{ key: "alpha", status: "conflict" }]);
    assert.equal(
      JSON.parse(await readFile(path, "utf-8")).mcp.servers.alpha.command,
      "alpha-bin",
      "conflict 不能写文件",
    );

    const { hashes } = await service.getSyncContentHashes({ keys: ["alpha"] });
    assert.equal(hashes.alpha, mcpHash({ command: "alpha-bin" }));
    const applied = await service.importSyncItems({
      payload: {
        sourceHomeDir: home,
        items: [{ key: "alpha", name: "alpha", config: { command: "new-bin" }, enabled: true }],
      },
      items: [{ key: "alpha", mode: "overwrite", expectedTargetHash: hashes.alpha }],
    });
    assert.deepEqual(applied.results, [{ key: "alpha", status: "updated" }]);
    assert.equal(JSON.parse(await readFile(path, "utf-8")).mcp.servers.alpha.command, "new-bin");
  });
});

test("mcp createOnly 在同 key 已存在时返回 conflict，而不是覆盖", async () => {
  await withTempHome(async (home) => {
    await writeCliConfig(home, { mcp: { servers: { alpha: { command: "alpha-bin" } } } });
    const service = createMcpDataSyncMethods();
    const result = await service.importSyncItems({
      payload: {
        sourceHomeDir: home,
        items: [{ key: "alpha", name: "Alpha", config: { command: "other" }, enabled: false }],
      },
      items: [{ key: "alpha", mode: "createOnly" }],
    });
    assert.deepEqual(result.results, [{ key: "alpha", status: "conflict" }]);
  });
});

test("device sync state 串行写入且损坏文件按未同步读取", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcodium-device-state-"));
  try {
    const filePath = join(home, "data-sync-state.json");
    let now = 1_000;
    const service = createDeviceSyncStateService({ filePath, now: () => now++ });
    // 并发写入不能互相覆盖（同一 Host 内串行队列）。
    const devices = ["source-a", "source-b", "source-c", "source-d"];
    await Promise.all(
      devices.map((sourceServerId, index) =>
        service.recordDeviceSyncResult({
          sourceServerId,
          result: index % 2 === 0 ? "success" : "partial",
        }),
      ),
    );
    const states = await service.getDeviceSyncStates();
    assert.deepEqual(Object.keys(states).sort(), devices);
    assert.equal(states["source-a"]?.lastResult, "success");
    assert.equal(states["source-b"]?.lastResult, "partial");

    await writeFile(filePath, "{not json", "utf-8");
    assert.deepEqual(await service.getDeviceSyncStates(), {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("directory content 不跟随内部软链，并拒绝越界路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-dir-content-"));
  try {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", "file.txt"), "hello", "utf-8");
    await symlink(join(root, "nested", "file.txt"), join(root, "link.txt"));
    const scan = await scanDirectoryContent(root);
    assert.equal(scan.containsSymlink, true);
    assert.equal(scan.fileCount, 1);
    // 软链只哈希 readlink 目标，不读被指向的文件内容：改被指向的内容不影响哈希。
    const before = await hashDirectoryContent(root);
    await writeFile(join(root, "nested", "file.txt"), "changed", "utf-8");
    const after = await hashDirectoryContent(root);
    assert.notEqual(before, after);
    assert.equal(isPathWithin(root, join(root, "nested")), true);
    assert.equal(isPathWithin(root, root), false);
    assert.equal(isPathWithin(root, join(root, "..", "escape")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command import 拒绝越界相对路径与 ~/.agents 兼容目录覆盖", async () => {
  await withTempHome(async (home) => {
    const service = createCommandDataSyncMethods();
    const escape = await service.importSyncItems({
      payload: {
        sourceHomeDir: home,
        items: [
          {
            key: "/evil",
            name: "/evil",
            relativePath: "../evil.md",
            content: new Uint8Array([1, 2, 3]),
            enabled: true,
          },
        ],
      },
      items: [{ key: "/evil", mode: "createOnly" }],
    });
    assert.equal(escape.results[0]?.status, "failed");
    assert.match(escape.results[0]?.error ?? "", /invalid command path/u);

    // 兼容目录里的同名命令作为目标时不能覆盖：整个导入该项失败。
    const agentsCommand = join(home, ".agents", "commands", "deploy.md");
    await mkdir(join(home, ".agents", "commands"), { recursive: true });
    await writeFile(agentsCommand, "---\ndescription: agent copy\n---\nbody\n", "utf-8");
    const { hashes } = await service.getSyncContentHashes({ keys: ["/deploy"] });
    const overwrite = await service.importSyncItems({
      payload: {
        sourceHomeDir: home,
        items: [
          {
            key: "/deploy",
            name: "/deploy",
            relativePath: "deploy.md",
            content: new Uint8Array([1, 2, 3]),
            enabled: true,
          },
        ],
      },
      items: [{ key: "/deploy", mode: "overwrite", expectedTargetHash: hashes["/deploy"] }],
    });
    assert.equal(overwrite.results[0]?.status, "failed");
    assert.match(overwrite.results[0]?.error ?? "", /~\/\.agents\/commands/u);
    assert.equal(
      await readFile(agentsCommand, "utf-8"),
      "---\ndescription: agent copy\n---\nbody\n",
    );
  });
});

test("command createOnly 拒绝命令根或祖先目录软链，不向链接目标写入", async () => {
  await withTempHome(async (home) => {
    const outside = await mkdtemp(join(tmpdir(), "zcodium-command-outside-"));
    try {
      const commandsRoot = join(home, ZCODE_USER_DATA_DIR_NAME, "commands");
      await mkdir(dirname(commandsRoot), { recursive: true });
      await symlink(outside, commandsRoot);
      const service = createCommandDataSyncMethods();
      const result = await service.importSyncItems({
        payload: {
          sourceHomeDir: home,
          items: [
            {
              key: "/deploy",
              name: "/deploy",
              relativePath: "deploy.md",
              content: new Uint8Array([1, 2, 3]),
              enabled: true,
            },
          ],
        },
        items: [{ key: "/deploy", mode: "createOnly" }],
      });
      assert.equal(result.results[0]?.status, "failed");
      assert.match(result.results[0]?.error ?? "", /symlink/u);
      await assert.rejects(readFile(join(outside, "deploy.md")), { code: "ENOENT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("updateJsonObjectFile 读改写同锁，并发写入不互相覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcodium-cas-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, "{}\n", "utf-8");
    // 同一路径的读、修改、替换必须串行；否则每个并发调用都基于旧快照写回，后写者覆盖先写者。
    const fields = Array.from({ length: 12 }, (_value, index) => `field${index}`);
    await Promise.all(
      fields.map((field) =>
        updateJsonObjectFile(path, (current) => ({ ...current, [field]: true })),
      ),
    );
    const written = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written).sort(), [...fields].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inline plugin import 在被占用的目录名旁新建唯一条目", async () => {
  await withTempHome(async (home) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "zcodium-plugin-source-"));
    try {
      await mkdir(join(sourceRoot, ZCODE_PLUGIN_MANIFEST_DIR_NAME), { recursive: true });
      const manifestPath = join(sourceRoot, ZCODE_PLUGIN_MANIFEST_DIR_NAME, "plugin.json");
      await writeFile(manifestPath, JSON.stringify({ name: "demo", version: "1.0.0" }), "utf-8");
      const archive = await createPluginSyncArchive({
        entries: [
          {
            sourcePath: manifestPath,
            archivePath: `demo/${ZCODE_PLUGIN_MANIFEST_DIR_NAME}/plugin.json`,
          },
        ],
        metadata: { plugins: [{ name: "demo", pluginId: "demo@inline", directoryName: "demo" }] },
      });
      // 目标端先占用首选目录名：新建必须退到带短哈希后缀的目录，不能覆盖已有内容。
      const occupied = join(home, ZCODE_USER_DATA_DIR_NAME, "plugins", "demo");
      await mkdir(occupied, { recursive: true });
      await writeFile(join(occupied, "keep.txt"), "keep", "utf-8");
      await writeCliConfig(home, { plugins: { dirs: [] } });

      const service = createInlinePluginDataSyncMethods({ maxItemBytes: 10 * 1024 * 1024 });
      const result = await service.importSyncItems({
        payload: {
          archive,
          sourceHomeDir: home,
          items: [
            {
              key: "demo@inline",
              pluginId: "demo@inline",
              directoryName: "demo",
              enabled: true,
              options: {},
            },
          ],
        },
        items: [{ key: "demo@inline", mode: "createOnly" }],
      });
      assert.equal(result.results[0]?.status, "created");
      assert.equal(await readFile(join(occupied, "keep.txt"), "utf-8"), "keep");
      const config = JSON.parse(await readFile(cliConfigPath(home), "utf-8"));
      const registered = (config.plugins.dirs as string[]).filter(
        (dir) => dir !== occupied && dir.startsWith(join(occupied, "..")),
      );
      assert.equal(registered.length, 1, "新建插件登记到唯一目录");
      const listed = await service.listSyncItems();
      assert.equal(listed.items[0]?.key, "demo@inline");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

test("user-config-sync 未知 category 直接报错，不回退到任何分类", async () => {
  const service = createUserConfigSyncService();
  await assert.rejects(
    service.listSyncItems({ category: "unknown" as never }),
    /unknown user config sync category/u,
  );
});
