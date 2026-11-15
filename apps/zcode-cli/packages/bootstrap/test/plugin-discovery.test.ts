import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  PluginActivationStatus,
  PluginDiscoveryCandidate,
  PluginDiscoveryContext,
} from "@zcode/contracts";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { writeOfficialMarketplace } from "../src/app/bundled-plugin-seed-cache.js";
import { createPluginDiscoveryPort } from "../src/plugin-discovery/port.js";
import { OfficialPluginCatalogRefresh } from "../src/plugin-discovery/refresh.js";
import { searchPluginCatalog } from "../src/plugin-discovery/search.js";
import { createStorePluginDiscoveryPort } from "../src/plugin-discovery-store.js";
import { createZCodeApp } from "../src/app/create-app.js";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";
import type { ZCodeApp } from "../src/app/types.js";

const ENV_KEYS = ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ZCODE_STORAGE_DIR"];

function context(pluginCallId = "tool-call-1"): PluginDiscoveryContext {
  return {
    sessionId: "sess_1",
    turnId: "turn-1",
    toolCallId: pluginCallId,
    traceId: "trace-1",
    signal: new AbortController().signal,
  };
}

function candidate(overrides: Partial<PluginDiscoveryCandidate> = {}): PluginDiscoveryCandidate {
  return {
    pluginId: "documents@zcode-plugins-official",
    name: "documents",
    installed: false,
    enabled: false,
    action: "install",
    scope: "workspace",
    description: "Render and edit office documents",
    ...overrides,
  };
}

/** 只读目录；写入口由各测试显式替换，用来断言「没被调用」。 */
function deps(
  catalog: PluginDiscoveryCandidate[],
  overrides: Partial<Parameters<typeof createPluginDiscoveryPort>[0]> = {},
) {
  return {
    list: () => catalog,
    resolve: async (pluginId: string) => catalog.find((entry) => entry.pluginId === pluginId),
    refresh: async () => ({ stale: false }),
    apply: async () => true,
    activate: async () => "ready" as PluginActivationStatus,
    ...overrides,
  };
}

test("search marks stale catalogs and paginates with a revision-bound cursor", async () => {
  const entries = Array.from({ length: 12 }, (_unused, index) =>
    candidate({
      pluginId: `documents-${index}@zcode-plugins-official`,
      name: `documents-${index}`,
      description: "documents helper",
    }),
  );
  const port = createPluginDiscoveryPort(
    deps(entries, { refresh: async () => ({ stale: true }) }),
  );
  const first = await port.search({ query: "documents" }, context());
  assert.equal(first.stale, true);
  assert.equal(first.plugins.length, 10);
  assert.ok(first.cursor);
  const second = await port.search({ query: "documents", cursor: first.cursor }, context());
  assert.equal(second.plugins.length, 2);
  assert.equal(second.cursor, undefined);
  // 分页不重不漏。
  const ids = new Set([...first.plugins, ...second.plugins].map((entry) => entry.pluginId));
  assert.equal(ids.size, 12);
});

test("a cursor from another catalog revision fails instead of silently re-paging", () => {
  const before = searchPluginCatalog([candidate()], { query: "documents" }, false);
  assert.equal(before.cursor, undefined);
  const many = Array.from({ length: 11 }, (_unused, index) =>
    candidate({ pluginId: `d-${index}@zcode-plugins-official`, name: `documents-${index}` }),
  );
  const first = searchPluginCatalog(many, { query: "documents" }, false);
  assert.ok(first.cursor);
  assert.throws(
    () => searchPluginCatalog([...many, candidate({ pluginId: "extra@zcode-plugins-official" })], { query: "documents", cursor: first.cursor }, false),
    /cursor_expired/,
  );
});

test("search ranking prefers exact names and keeps technical detail out of the model result", () => {
  const result = searchPluginCatalog(
    [
      candidate({
        pluginId: "sheets@zcode-plugins-official",
        name: "sheets",
        description: "documents spreadsheets",
        examplePrompts: ["x".repeat(5_000)],
        displayNameI18n: { "zh-CN": "表格", "en-US": "Sheets" },
      }),
      candidate({ pluginId: "documents@zcode-plugins-official", name: "documents" }),
    ],
    { query: "documents" },
    false,
  );
  assert.equal(result.plugins[0]?.pluginId, "documents@zcode-plugins-official");
  for (const plugin of result.plugins)
    assert.deepEqual(Object.keys(plugin).sort(), [
      "action",
      "description",
      "displayName",
      "enabled",
      "installed",
      "name",
      "pluginId",
      "scope",
    ]);
});

test("suggest refuses non-official ids and absent catalog entries", async () => {
  const port = createPluginDiscoveryPort(deps([candidate()]));
  const foreign = await port.suggest(
    { pluginId: "documents@some-other-market", reason: "x" },
    context(),
  );
  assert.equal(foreign.status, "unavailable");
  const missing = await port.suggest(
    { pluginId: "pdf@zcode-plugins-official", reason: "x" },
    context(),
  );
  assert.equal(missing.status, "unavailable");
});

test("suggest re-reads the catalog after confirmation and refuses changed state", async () => {
  let applied = 0;
  let reads = 0;
  const port = createPluginDiscoveryPort(
    deps([candidate()], {
      resolve: async (pluginId: string) => {
        reads += 1;
        // 第 2 次解析发生在「确认后」：目录/安装态已经变了。
        return reads === 1 ? candidate({ pluginId }) : candidate({ action: "enable" });
      },
      apply: async () => {
        applied += 1;
        return true;
      },
    }),
  );
  const result = await port.suggest(
    { pluginId: "documents@zcode-plugins-official", reason: "render docx" },
    context(),
  );
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /changed during confirmation/);
  assert.equal(applied, 0, "目录变化时不允许落盘");
});

test("suggest installs and reports activation, mapping verification failures honestly", async () => {
  const applied: string[] = [];
  const port = createPluginDiscoveryPort(
    deps([candidate()], {
      apply: async (plugin) => {
        applied.push(plugin.pluginId);
        return true;
      },
      activate: async () => "refreshRequired",
    }),
  );
  const installed = await port.suggest(
    { pluginId: "documents@zcode-plugins-official", reason: "render docx" },
    context(),
  );
  assert.equal(installed.status, "installed");
  assert.equal(installed.activation, "refreshRequired");
  assert.match(installed.message, /Do not use the new capability/);
  assert.deepEqual(applied, ["documents@zcode-plugins-official"]);

  const failing = createPluginDiscoveryPort(
    deps([candidate()], {
      apply: async () => {
        throw new Error("install failed: permission denied");
      },
    }),
  );
  const failed = await failing.suggest(
    { pluginId: "documents@zcode-plugins-official", reason: "x" },
    context(),
  );
  assert.equal(failed.status, "failed");
});

test("an already available plugin reports its activation without writing", async () => {
  let applied = 0;
  const port = createPluginDiscoveryPort(
    deps([candidate({ installed: true, enabled: true, action: "none" })], {
      apply: async () => {
        applied += 1;
        return false;
      },
      activate: async () => "disabled",
    }),
  );
  const result = await port.suggest(
    { pluginId: "documents@zcode-plugins-official", reason: "x" },
    context(),
  );
  assert.equal(result.status, "alreadyAvailable");
  assert.equal(result.activation, "disabled");
  assert.equal(applied, 0);
});

test("refresh failure blocks installation even after confirmation", async () => {
  let applied = 0;
  const port = createPluginDiscoveryPort(
    deps([candidate()], {
      // 确认后的强制重读失败：目录不可信时不能落盘。
      refresh: async () => ({ stale: true }),
      apply: async () => {
        applied += 1;
        return true;
      },
    }),
  );
  const result = await port.suggest(
    { pluginId: "documents@zcode-plugins-official", reason: "x" },
    context(),
  );
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /Nothing was installed/);
  assert.equal(applied, 0);
});

test("repeated dispatch of the same tool call reuses one operation", async () => {
  let calls = 0;
  let applied = 0;
  const port = createPluginDiscoveryPort(
    deps([candidate()], {
      resolve: async () => {
        calls += 1;
        return candidate();
      },
      apply: async () => {
        applied += 1;
        return true;
      },
    }),
  );
  const [first, second] = await Promise.all([
    port.suggest({ pluginId: "documents@zcode-plugins-official", reason: "x" }, context()),
    port.suggest({ pluginId: "documents@zcode-plugins-official", reason: "x" }, context()),
  ]);
  assert.deepEqual(first, second);
  assert.equal(applied, 1, "同一 toolCallId 只落盘一次");
  // 不同调用各自确认（新的 toolCallId → 新的操作）。
  await port.suggest({ pluginId: "documents@zcode-plugins-official", reason: "x" }, context("tool-call-2"));
  assert.equal(applied, 2);
  assert.ok(calls >= 4);
});

test("catalog refresh single-flights and drops results from flights that lost all readers", async () => {
  let now = 0;
  const refresh = new OfficialPluginCatalogRefresh(() => now);
  let updates = 0;
  const update = async () => {
    updates += 1;
    await Promise.resolve();
  };
  const shared = await Promise.all([
    refresh.ensure("root", undefined, update, { force: false, signal: new AbortController().signal }),
    refresh.ensure("root", undefined, update, { force: false, signal: new AbortController().signal }),
  ]);
  assert.deepEqual(shared, [{ stale: false }, { stale: false }]);
  assert.equal(updates, 1, "并发读者共享同一次刷新");

  // 节流：同 key 在间隔内不再刷新。
  now = 1_000;
  await refresh.ensure("root", undefined, update, { force: false, signal: new AbortController().signal });
  assert.equal(updates, 1);

  // 最后一个读者取消后 flight 必须中止，不能把结果发布给随后的确认请求。
  const controller = new AbortController();
  let released!: () => void;
  const pending = refresh.ensure(
    "root2",
    undefined,
    () =>
      new Promise<void>((resolve) => {
        released = resolve;
      }),
    { force: false, signal: controller.signal },
  );
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  released();
});

/** 只写临时 HOME/XDG/存储：不读真实用户配置或插件目录。 */
async function tempStorage(t: { after(fn: () => Promise<void>): void }, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const cliStorage = join(root, "data", "cli");
  const pluginStorage = join(cliStorage, "plugins");
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "cache"), { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.XDG_DATA_HOME = join(root, "data");
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

test("store-backed catalog projects the real official marketplace into candidates", async (t) => {
  const fixture = await tempStorage(t, "zcode-plugin-discovery-");
  const names = ["documents", "pdf"];
  await writeOfficialMarketplace(fixture.pluginStorage, {
    kind: "filesystem",
    plugins: names.map((name) => ({
      definition: OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === name)!,
      files: [],
      hash: name,
      missingSeedPaths: [],
    })),
  });
  const userConfigPath = join(fixture.root, "config.json");
  await writeFile(userConfigPath, JSON.stringify({ plugins: { enabled: true } }));

  const port = createStorePluginDiscoveryPort({
    env: {},
    pluginStorageRoot: fixture.pluginStorage,
    userConfigPath,
    workingDirectory: fixture.root,
    loadedPluginIds: () => new Set<string>(),
    refresh: new OfficialPluginCatalogRefresh(() => 0),
  });
  const result = await port.search({ query: "documents" }, context());
  const entry = result.plugins.find((plugin) => plugin.name === "documents");
  assert.ok(entry, JSON.stringify(result));
  assert.equal(entry.pluginId, "documents@zcode-plugins-official");
  // 会话内确认只授权当前 workspace。
  assert.equal(entry.scope, "workspace");
  // 动作必须与「已安装 / 已启用」一致，不能出现「装着却要求安装」的矛盾投影。
  assert.equal(
    entry.action,
    entry.installed ? (entry.enabled ? "none" : "enable") : "install",
  );
  // 官方市场的候选必须带市场 listing 的可见元数据（名称来自目录条目）。
  assert.equal(entry.name, "documents");
});

function createEmptyRegistry(): ProviderRegistryModelSource {
  const view = { providers: [], models: [] } as unknown as ReturnType<
    ProviderRegistryModelSource["getView"]
  >;
  return {
    getModel: () => undefined,
    getProvider: () => undefined,
    getView: () => view,
    onDidChange: () => () => undefined,
    validateSelection: (selection) => ({
      code: "model-not-found",
      modelId: selection.modelId,
      ok: false,
      providerId: selection.providerId,
    }),
  };
}

async function createApp(directory: string, workspace: string): Promise<ZCodeApp> {
  return createZCodeApp({
    env: {
      ...process.env,
      HOME: join(directory, "home"),
      XDG_CONFIG_HOME: join(directory, "xdg-config"),
      XDG_DATA_HOME: join(directory, "xdg-data"),
      ZCODE_DATA_BASE_DIR: join(directory, "data"),
    },
    providerRegistry: createEmptyRegistry(),
    runtimeConfig: { workingDirectory: workspace },
    skipUserConfig: true,
  });
}

/**
 * 真实 App 路由：工具经 create-app → runtime-tools 注册门 → 真实 ToolExecutor →
 * 真实插件 store。断言不是「导出了函数」，而是这个 App 真的能跑这条链。
 */
test("the real app registers the discovery tools and routes them through the plugin store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-discovery-app-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(directory, "home"), { recursive: true });
  const app = await createApp(directory, workspace);
  try {
    const names = new Set(app.runtime.registry.list());
    assert.ok(names.has("SearchPlugins"), "real app must register SearchPlugins");
    assert.ok(names.has("SuggestPluginInstall"), "real app must register SuggestPluginInstall");
    assert.equal(app.runtime.registry.getMetadata("SearchPlugins")?.readOnly, true);

    const toolCall = {
      id: "call-search-1",
      name: "SearchPlugins",
      input: { query: "documents" },
    } as never;
    const schedule = await app.runtime.scheduleTools([toolCall]);
    const execution = await app.runtime.executeTools([toolCall], schedule);
    assert.equal(execution.results.length, 1);
    // 目录服务真实执行：不抛能力缺席，结果形状符合 schema（可能为空目录）。
    assert.equal(execution.results[0]?.success, true, JSON.stringify(execution.results[0]));

    // 没有审批通道的 App：安装意图必须被拒绝，不能静默落盘。
    const suggestCall = {
      id: "call-suggest-1",
      name: "SuggestPluginInstall",
      input: { pluginId: "documents@zcode-plugins-official", reason: "render docx" },
    } as never;
    const suggestSchedule = await app.runtime.scheduleTools([suggestCall]);
    const suggestExecution = await app.runtime.executeTools([suggestCall], suggestSchedule);
    assert.equal(suggestExecution.results[0]?.success, false, "无审批通道时不允许安装");
  } finally {
    await app.close?.();
    await rm(directory, { force: true, recursive: true });
  }
});
