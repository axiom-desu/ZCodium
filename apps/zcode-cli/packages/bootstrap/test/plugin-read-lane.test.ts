import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { describeMarketplacePlugin } from "@zcode/adapters/plugins";
import { writeOfficialMarketplace } from "../src/app/bundled-plugin-seed-cache.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { withPluginStorageLock } from "../src/lib/plugin-storage-lock.js";
import { getZCodePluginsOverview } from "../src/plugin-overview.js";
import { describePlugin } from "../src/zcode-protocol/plugins.js";
import { ZCodeProtocolNdjsonConnection } from "../src/zcode-protocol/transport.js";

const ENV_KEYS = [
  "HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "ZCODE_STORAGE_DIR",
];

const DOCUMENT_PLUGIN_NAMES = ["documents", "pdf", "presentations", "spreadsheets"];
const OFFICIAL_PLUGIN_ID = (name: string) => `${name}@zcode-plugins-official`;

/** `apps/zcode-cli/packages`：内置插件包的根（fileURLToPath 兼顾 Windows 盘符）。 */
function packagesRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/**
 * 只把卡死变成可读失败：真正的同步屏障是 latch，断言不看时间差。
 * 被观察的代码路径是毫秒级 fs/协议处理，窗口只用于避免 CI 挂死。
 */
const DETECT_MS = 10_000;

async function withDetector<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`卡死探测器：${label}`)), DETECT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 只等事实信号：latch 由被测代码路径触发，不用超时或 sleep 掩盖同步问题。 */
function latch() {
  const deferred = Promise.withResolvers<void>();
  return {
    promise: deferred.promise,
    resolve: () => deferred.resolve(),
    settled: false,
  };
}

/** 只用临时 HOME/storage：不读写真实用户配置、数据库或日志。 */
async function tempStorage(t: { after(fn: () => Promise<void>): void }, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const cliStorage = join(root, "data", "cli");
  const pluginStorage = join(cliStorage, "plugins");
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.XDG_DATA_HOME = join(root, "data");
  // `getCliStorageRoot` 以 basename === "cli" 判定根目录，这里直接指向临时 cli 根。
  process.env.ZCODE_STORAGE_DIR = cliStorage;
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { force: true, recursive: true });
  });
  return { cliStorage, pluginStorage, root };
}

async function writeCachedMarketplace(storageRoot: string, id = "e2e-describe"): Promise<void> {
  const directory = join(storageRoot, "marketplaces", id);
  await mkdir(join(directory, "local", "skills", "describe-marker"), { recursive: true });
  await writeFile(
    join(directory, "marketplace.json"),
    JSON.stringify({ name: id, plugins: [{ name: "local", source: "./local" }] }),
  );
  await writeFile(
    join(directory, "local", "skills", "describe-marker", "SKILL.md"),
    "---\nname: describe-marker\ndescription: Describe marker\n---\n",
  );
}

async function writeKnownMarketplace(
  storageRoot: string,
  record: Record<string, unknown>,
): Promise<void> {
  await mkdir(storageRoot, { recursive: true });
  await writeFile(
    join(storageRoot, "known_marketplaces.json"),
    JSON.stringify({ marketplaces: [record], version: 1 }),
  );
}

function describeParams(root: string, marketplace: string, pluginName: string) {
  return { marketplace, pluginName, workspace: { workspaceKey: root, workspacePath: root } };
}

test("cached marketplace describe completes while an install holds the storage lock", async (t) => {
  const fixture = await tempStorage(t, "zcode-plugin-read-cached-");
  await writeCachedMarketplace(fixture.pluginStorage);

  // 模拟长安装：真实 storage lock 被占住，直到测试显式放行。
  const installHeld = latch();
  const installEntered = latch();
  const install = withPluginStorageLock(fixture.pluginStorage, async () => {
    installEntered.resolve();
    await installHeld.promise;
  });
  await installEntered.promise;

  const lockFree = latch();
  const marker = withPluginStorageLock(fixture.pluginStorage, async () => undefined).then(() => {
    lockFree.settled = true;
    lockFree.resolve();
  });
  const describe = describePlugin(
    {} as never,
    describeParams(fixture.root, "e2e-describe", "local"),
  );
  try {
    const winner = await Promise.race([
      describe.then((result) => (lockFree.settled ? "serialized" : result)),
      lockFree.promise.then(() => "lock-free"),
    ]);
    assert.notEqual(winner, "lock-free", "已缓存 manifest 的详情读取不能排在安装后面");
    assert.notEqual(winner, "serialized", "详情读取不能串到 storage lock 队列");
    assert.match(JSON.stringify(winner), /describe-marker/);
  } finally {
    installHeld.resolve();
    await install;
    await marker;
  }
});

test("describe of a marketplace that must be written still queues on the storage lock", async (t) => {
  const fixture = await tempStorage(t, "zcode-plugin-read-missing-");
  const order: string[] = [];
  const installHeld = latch();
  const installEntered = latch();
  const install = withPluginStorageLock(fixture.pluginStorage, async () => {
    installEntered.resolve();
    await installHeld.promise;
  });
  await installEntered.promise;

  // marker 排在同一锁链的下一格：describe 若绕过了锁，会排在 marker 前面完成。
  const marker = withPluginStorageLock(fixture.pluginStorage, async () => {
    order.push("marker");
  });
  const describe = describePlugin(
    {} as never,
    describeParams(fixture.root, "missing-marketplace", "missing"),
  ).then(() => {
    order.push("describe");
  });
  installHeld.resolve();
  await install;
  await marker;
  // 懒加载 manifest 是写路径：必须等既有写锁，而不是跳过保护或另建一把锁。
  assert.deepEqual(order, ["marker"], "详情写入懒加载 manifest 时必须排在既有 storage lock 里");
  await describe;
  assert.deepEqual(order, ["marker", "describe"]);
});

test("two concurrent describes of one missing marketplace fill it once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-read-singleflight-"));
  t.after(() => rm(root, { force: true, recursive: true }).then(() => undefined));
  const storageRoot = join(root, "plugins");
  // 市场来源目录必须与 plugin storage 分离：file 来源会把整个来源目录复制进缓存。
  const sourceRoot = join(root, "source");
  const sourcePath = join(sourceRoot, "marketplace.json");
  await mkdir(join(sourceRoot, "local", "skills", "shared-marker"), { recursive: true });
  await writeFile(
    join(sourceRoot, "local", "skills", "shared-marker", "SKILL.md"),
    "---\nname: shared-marker\ndescription: Shared marker\n---\n",
  );
  await writeFile(
    sourcePath,
    JSON.stringify({ name: "shared-market", plugins: [{ name: "local", source: "./local" }] }),
  );
  await writeKnownMarketplace(storageRoot, {
    addedAt: "2026-01-01T00:00:00.000Z",
    id: "shared-market",
    name: "shared-market",
    pluginCount: 1,
    source: { path: sourcePath, source: "file" },
  });

  let lockedSections = 0;
  const withWriteLock = <T>(write: () => Promise<T>): Promise<T> =>
    withPluginStorageLock(storageRoot, async () => {
      lockedSections += 1;
      const value = await write();
      if (lockedSections === 1) {
        // 第一次填充完成后再破坏来源：锁内缺少二次检查时，第二个读会重新抓取并拿到错误。
        await writeFile(sourcePath, "{ not-a-marketplace");
      }
      return value;
    });
  const describe = () =>
    describeMarketplacePlugin({
      marketplace: "shared-market",
      name: "local",
      storageRoot,
      withWriteLock,
    });

  const [first, second] = await Promise.all([describe(), describe()]);
  // 两个读在预检查时都看到缺 manifest，因此都进锁；只有第一个真正抓取并写盘。
  assert.equal(lockedSections, 2);
  assert.deepEqual(second.diagnostics, []);
  assert.deepEqual(first.diagnostics, []);
  assert.match(JSON.stringify(second), /shared-marker/);
});

test("a failing describe releases the storage lock for later readers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-read-release-"));
  t.after(() => rm(root, { force: true, recursive: true }).then(() => undefined));
  const storageRoot = join(root, "plugins");
  await writeKnownMarketplace(storageRoot, {
    addedAt: "2026-01-01T00:00:00.000Z",
    id: "broken-market",
    name: "broken-market",
    pluginCount: 1,
    source: { path: join(root, "absent.json"), source: "file" },
  });

  const failed = await describeMarketplacePlugin({
    marketplace: "broken-market",
    name: "local",
    storageRoot,
    withWriteLock: (write) => withPluginStorageLock(storageRoot, write),
  });
  assert.ok(failed.diagnostics.length > 0);

  // 失败不能让锁链一直挂着：下一个真实临界区必须能进入（latch 由锁自身放行）。
  const released = latch();
  await withPluginStorageLock(storageRoot, async () => released.resolve());
  await released.promise;

  const cachedStorage = join(root, "cached-plugins");
  await writeCachedMarketplace(cachedStorage);
  const cached = await describeMarketplacePlugin({
    marketplace: "e2e-describe",
    name: "local",
    storageRoot: cachedStorage,
  });
  assert.ok(cached.components.length > 0);
});

test("plugin read requests bypass a long ordinary request without reordering commands", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const order: string[] = [];
  const longEntered = latch();
  const longFinishing = latch();
  const readsHandled = latch();
  const laterEntered = latch();
  const readMethods = new Set(["plugins/describe", "plugins/list", "plugins/overview"]);
  const handledReads = new Set<string>();
  const connection = new ZCodeProtocolNdjsonConnection({
    input,
    output,
    async handleMessage(message) {
      if (!("method" in message) || !("id" in message)) return;
      order.push(message.method);
      if (message.method === "session/create") {
        longEntered.resolve();
        await longFinishing.promise;
      }
      if (readMethods.has(message.method)) {
        handledReads.add(message.method);
        if (handledReads.size === readMethods.size) readsHandled.resolve();
      }
      if (message.method === "session/read") {
        laterEntered.settled = true;
        laterEntered.resolve();
      }
      return { id: message.id, result: {} };
    },
  });
  connection.start();
  t.after(async () => {
    longFinishing.resolve();
    input.end();
    await connection.waitForClose();
  });
  input.write('{"id":1,"method":"session/create"}\n');
  await longEntered.promise;
  input.write('{"id":2,"method":"plugins/describe"}\n');
  input.write('{"id":3,"method":"plugins/list"}\n');
  input.write('{"id":4,"method":"plugins/overview"}\n');
  input.write('{"id":5,"method":"session/read"}\n');
  await withDetector(readsHandled.promise, "只读插件方法必须在长请求结束前完成");
  // 只读插件方法在长请求结束前就已处理；普通请求仍按到达顺序排在它后面。
  assert.deepEqual(order, [
    "session/create",
    "plugins/describe",
    "plugins/list",
    "plugins/overview",
  ]);
  assert.equal(laterEntered.settled, false, "普通请求不能越过仍在执行的串行队列");
  longFinishing.resolve();
  await withDetector(laterEntered.promise, "普通请求必须在长请求后被串行执行");
  assert.deepEqual(order, [
    "session/create",
    "plugins/describe",
    "plugins/list",
    "plugins/overview",
    "session/read",
  ]);
});

test("bundled document plugins keep the ui component type, including restored entries", async (t) => {
  for (const name of DOCUMENT_PLUGIN_NAMES) {
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === name);
    assert.ok(definition, `missing definition ${name}`);
    assert.deepEqual(definition.componentTypes, ["ui"], name);
  }
  // 单向守卫：插件包声明了 ui.surfaces 时，definition 必须同时声明 "ui"；
  // 其余内置插件不得凭空带 "ui" 分类。
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (DOCUMENT_PLUGIN_NAMES.includes(definition.name)) continue;
    assert.equal(definition.componentTypes?.includes("ui") ?? false, false, definition.name);
    const manifestPath = join(
      packagesRoot(),
      basename(definition.rootCandidates[0] ?? ""),
      ".zcodium-plugin",
      "plugin.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      ui?: { surfaces?: unknown[] };
    };
    assert.equal(
      definition.componentTypes?.includes("ui") ?? false,
      (manifest.ui?.surfaces?.length ?? 0) > 0,
      `${definition.name} 的 ui 分类必须与 manifest 的 ui.surfaces 一致`,
    );
  }

  const fixture = await tempStorage(t, "zcode-plugin-ui-types-");
  await writeOfficialMarketplace(fixture.pluginStorage, {
    kind: "filesystem",
    plugins: DOCUMENT_PLUGIN_NAMES.map((name) => ({
      definition: OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === name)!,
      files: [],
      hash: name,
      missingSeedPaths: [],
    })),
  });
  const userConfigPath = join(fixture.root, "config.json");
  await writeFile(
    userConfigPath,
    JSON.stringify({
      plugins: { enabled: true, suppressedBuiltins: [OFFICIAL_PLUGIN_ID("documents")] },
    }),
  );
  const overview = await getZCodePluginsOverview({
    env: {},
    pluginStorageRoot: fixture.pluginStorage,
    userConfigPath,
    workingDirectory: fixture.root,
  });
  const available = overview.availablePlugins.find(
    (plugin) => plugin.id === OFFICIAL_PLUGIN_ID("documents"),
  );
  assert.ok(available?.componentTypes?.includes("ui"), JSON.stringify(available));
  const restorable = overview.restorableBuiltins.find(
    (plugin) => plugin.id === OFFICIAL_PLUGIN_ID("documents"),
  );
  assert.deepEqual(restorable?.componentTypes, ["ui"]);
});

test("computer-use restore entry keeps the CUA feature gate", async (t) => {
  const fixture = await tempStorage(t, "zcode-plugin-cua-gate-");
  const userConfigPath = join(fixture.root, "config.json");
  await writeFile(
    userConfigPath,
    JSON.stringify({
      plugins: { enabled: true, suppressedBuiltins: [OFFICIAL_PLUGIN_ID("computer-use")] },
    }),
  );
  const restorableWith = async (env: NodeJS.ProcessEnv) =>
    (
      await getZCodePluginsOverview({
        env,
        pluginStorageRoot: fixture.pluginStorage,
        userConfigPath,
        workingDirectory: fixture.root,
      })
    ).restorableBuiltins.some((plugin) => plugin.id === OFFICIAL_PLUGIN_ID("computer-use"));

  assert.equal(await restorableWith({ ZCODE_CUA_PRODUCT_HELPER: "0" }), false);
  assert.equal(await restorableWith({ ZCODE_CUA_PRODUCT_HELPER: "1" }), true);
});

test("EOF 期间已受理的插件读请求仍写出响应，不丢已受理的回复", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const entered = latch();
  const release = latch();
  const eof = latch();
  const written: string[] = [];
  output.on("data", (chunk: Buffer | string) => written.push(String(chunk)));
  const connection = new ZCodeProtocolNdjsonConnection({
    input,
    output,
    onTransportClosed: () => eof.resolve(),
    async handleMessage(message) {
      if (!("method" in message) || !("id" in message)) return;
      entered.resolve();
      await release.promise;
      return { id: message.id, result: { ok: true } };
    },
  });
  connection.start();
  t.after(async () => {
    release.resolve();
    input.end();
    await connection.waitForClose();
  });
  input.write('{"id":7,"method":"plugins/describe"}\n');
  await withDetector(entered.promise, "插件读请求必须立即进入 handler");
  // 客户端 EOF：此时普通串行队列已空，但读 handler 仍在飞（读请求不排串行队列）。
  // 半关闭必须等已受理的读回复落盘，不能因为串行链为空就立刻关闭连接。
  input.end();
  await withDetector(eof.promise, "EOF 必须通知 transport closed");
  release.resolve();
  await withDetector(connection.waitForClose(), "EOF 排空结束");
  assert.match(written.join(""), /"id":7/, "EOF 关闭前必须写出已受理读请求的响应");
});
