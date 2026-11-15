import { describe, expect, it, beforeEach } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { DataSyncListItem, SourceServerManagementSnapshot } from "@zcode/shared";
import {
  compareDataSyncItems,
  findMissingDataSyncDependencies,
  selectDataSyncHashRequests,
  type DataSyncRow,
} from "@/data-sync/domain/compareRows.js";
import {
  aggregateDeviceSyncResult,
  chunkDataSyncRows,
  resolveDataSyncCheckState,
} from "@/data-sync/domain/compareBatches.js";
import {
  buildMarketplacePluginSyncItems,
  resolveMarketplaceSourcePlan,
  selectUserMarketplacePlugins,
} from "@/data-sync/domain/marketplacePlugins.js";
import {
  maskDataSyncApiKey,
  resolveDataSyncProvisioningDisplay,
  toDataSyncProviderRows,
} from "@/data-sync/domain/providers.js";
import {
  buildDataSyncDevices,
  dataSyncConnectionKey,
  isDataSyncDeviceOnline,
  resolveTabSourceServerId,
  selectTabsOnDevice,
} from "@/data-sync/domain/devices.js";
import { isDataSyncUnsupportedError, StalePushError } from "@/data-sync/app/dataSyncErrors.js";
import {
  ensureDataSyncHashCache,
  readDataSyncHashCache,
  writeDataSyncHashCache,
} from "@/data-sync/app/dataSyncHashCache.js";
import { loadDataSyncCategory } from "@/data-sync/app/dataSyncCategoryLoad.js";
import { pushDataSyncCategory } from "@/data-sync/app/dataSyncPush.js";
import type { DataSyncCategoryAdapter } from "@/data-sync/app/categories.js";
import {
  resetDataSyncDialogStore,
  useDataSyncDialogStore,
} from "@/data-sync/app/dataSyncDialogStore.js";

function item(overrides: Partial<DataSyncListItem> & { key: string }): DataSyncListItem {
  return { name: overrides.key, enabled: true, ...overrides };
}

function service(
  items: DataSyncListItem[],
  hashes: Record<string, string>,
  importResults: Array<{ key: string; status: string }> = [],
) {
  const calls = { exports: [] as string[][], imports: [] as unknown[] };
  return {
    calls,
    listSyncItems: async () => ({ items, homeDir: "/home/fixture" }),
    getSyncContentHashes: async ({ keys }: { keys: string[] }) => ({
      hashes: Object.fromEntries(
        keys.filter((key) => key in hashes).map((key) => [key, hashes[key]]),
      ),
    }),
    checkSyncWriteAccess: async () => ({ ok: true, path: "/home/fixture" }),
    exportSyncItems: async ({ keys }: { keys: string[] }) => {
      calls.exports.push(keys);
      return { keys };
    },
    importSyncItems: async ({ items: importItems }: { items: Array<{ key: string }> }) => {
      calls.imports.push(importItems);
      const byKey = new Map(importResults.map((result) => [result.key, result.status]));
      return {
        results: importItems.map((entry) => ({
          key: entry.key,
          status: byKey.get(entry.key) ?? "created",
        })),
      };
    },
  };
}

function adapter(getService: DataSyncCategoryAdapter["getService"]): DataSyncCategoryAdapter {
  return { id: "mcp", icon: (() => null) as never, getService };
}

function accessorWith(services: Record<string, unknown>): IServiceAccessor {
  return services as unknown as IServiceAccessor;
}

describe("设置分区可见性", () => {
  it("只在桌面本机 base 设置显示数据同步分区", async () => {
    const { createSettingsPageConfig } = await import("@/settings/settingsPageConfig.js");
    const ids = (config: ReturnType<typeof createSettingsPageConfig>) =>
      config.settingsSections.map((section) => section.id);
    expect(ids(createSettingsPageConfig({ isDesktop: true, showDataSync: true }))).toContain(
      "dataSync",
    );
    expect(ids(createSettingsPageConfig({ isDesktop: true, showDataSync: false }))).not.toContain(
      "dataSync",
    );
    expect(ids(createSettingsPageConfig({ isDesktop: false, showDataSync: true }))).not.toContain(
      "dataSync",
    );
  });
});

describe("数据同步比较", () => {
  it("行状态、默认勾选与覆盖基线", () => {
    const rows = compareDataSyncItems({
      sourceItems: [
        item({ key: "new" }),
        item({ key: "same", signature: { fileCount: 1, totalBytes: 2 }, contentHash: "h1" }),
        item({ key: "differs", signature: { fileCount: 1, totalBytes: 2 } }),
        item({ key: "over", version: "2.0.0" }),
        item({ key: "blocked", exportBlockedReason: "size-limit" }),
      ],
      targetItems: [
        item({ key: "same", signature: { fileCount: 1, totalBytes: 2 }, contentHash: "h1" }),
        item({ key: "differs", signature: { fileCount: 1, totalBytes: 2 }, contentHash: "old" }),
        item({ key: "over", version: "1.0.0", contentHash: "t-over" }),
        item({ key: "remote-only" }),
      ],
      sourceHashes: { differs: "new" },
      targetHashes: { differs: "old" },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("new")?.status).toBe("push");
    expect(byKey.get("new")?.importMode).toBe("createOnly");
    expect(byKey.get("new")?.defaultSelected).toBe(true);
    expect(byKey.get("same")?.status).toBe("synced");
    expect(byKey.get("same")?.selectable).toBe(false);
    expect(byKey.get("differs")?.status).toBe("difference");
    expect(byKey.get("differs")?.defaultSelected).toBe(false);
    expect(byKey.get("differs")?.expectedTargetHash).toBe("old");
    expect(byKey.get("over")?.status).toBe("update");
    expect(byKey.get("over")?.importMode).toBe("overwrite");
    expect(byKey.get("blocked")?.status).toBe("blocked");
    expect(byKey.has("remote-only")).toBe(false);
    // 排序：push → update → difference → synced → blocked
    expect(rows.map((row) => row.status)).toEqual([
      "push",
      "update",
      "difference",
      "synced",
      "blocked",
    ]);
  });

  it("目标端整类不能导入时所有行 blocked", () => {
    const rows = compareDataSyncItems({
      sourceItems: [item({ key: "a" })],
      targetItems: [],
      sourceHashes: {},
      targetHashes: {},
      targetBlockedReason: "target-compat-config",
    });
    expect(rows[0]?.status).toBe("blocked");
    expect(rows[0]?.note).toEqual({
      kind: "blocked",
      reason: "target-compat-config",
    });
  });

  it("marketplace 版本行：同版本已同步、来源较旧不可选、最新版本不一致 blocked", () => {
    const rows = compareDataSyncItems({
      sourceItems: [
        item({ key: "same", version: "1.0.0", versionOnly: true, latestVersion: "1.0.0" }),
        item({ key: "older", version: "1.0.0", versionOnly: true, latestVersion: "1.0.0" }),
        item({ key: "mismatch", version: "2.0.0", versionOnly: true, latestVersion: "9.0.0" }),
        item({ key: "update", version: "2.0.0", versionOnly: true, latestVersion: "2.0.0" }),
      ],
      targetItems: [
        item({ key: "same", version: "1.0.0", versionOnly: true }),
        item({ key: "older", version: "1.5.0", versionOnly: true }),
        item({ key: "mismatch", version: "1.0.0", versionOnly: true, latestVersion: "1.0.0" }),
        item({ key: "update", version: "1.0.0", versionOnly: true, latestVersion: "2.0.0" }),
      ],
      sourceHashes: {},
      targetHashes: {},
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("same")?.status).toBe("synced");
    expect(byKey.get("older")?.status).toBe("difference");
    expect(byKey.get("older")?.note).toEqual({ kind: "sourceOlder" });
    expect(byKey.get("older")?.selectable).toBe(false);
    expect(byKey.get("mismatch")?.status).toBe("blocked");
    expect(byKey.get("update")?.status).toBe("update");
    expect(byKey.get("update")?.importMode).toBe("overwrite");
  });

  it("哈希请求只覆盖两端都有、签名相同且版本不能决定结果的项", () => {
    const requests = selectDataSyncHashRequests(
      [
        item({ key: "same", signature: { fileCount: 1, totalBytes: 4 } }),
        item({ key: "different-signature", signature: { fileCount: 2, totalBytes: 4 } }),
        item({ key: "version-decides", version: "2.0.0" }),
        item({ key: "blocked", exportBlockedReason: "size-limit" }),
      ],
      [
        item({ key: "same", signature: { fileCount: 1, totalBytes: 4 } }),
        item({ key: "different-signature", signature: { fileCount: 1, totalBytes: 4 } }),
        item({ key: "version-decides", version: "1.0.0" }),
        item({ key: "blocked" }),
      ],
    );
    expect(requests.targetKeys).toEqual(["same", "different-signature", "version-decides"]);
    expect(requests.sourceKeys).toEqual(["same"]);
    expect(
      selectDataSyncHashRequests(
        [item({ key: "a" })],
        [item({ key: "a" })],
        "target-compat-config",
      ),
    ).toEqual({ sourceKeys: [], targetKeys: [] });
  });

  it("依赖提示只报告本机有、目标端没有的引用", () => {
    const missing = findMissingDataSyncDependencies(
      { mcpServers: ["Alpha", "Internal"], skills: ["Review"] },
      {
        mcp: { source: new Set(["alpha", "internal"]), target: new Set(["alpha"]) },
        skills: { source: new Set(["review"]), target: new Set() },
      },
    );
    expect(missing).toEqual({ mcpServers: ["Internal"], skills: ["Review"] });
    expect(
      findMissingDataSyncDependencies(undefined, { mcp: undefined, skills: undefined }),
    ).toBeUndefined();
    expect(
      findMissingDataSyncDependencies(
        { mcpServers: ["alpha"] },
        { mcp: undefined, skills: undefined },
      ),
    ).toBeUndefined();
  });
});

describe("批次与勾选", () => {
  const rows: DataSyncRow[] = [
    {
      key: "parent",
      name: "parent",
      status: "push",
      note: { kind: "metadata" },
      selectable: true,
      defaultSelected: true,
      totalBytes: 100,
    },
    {
      key: "child",
      name: "child",
      parentKey: "parent",
      status: "push",
      note: { kind: "metadata" },
      selectable: true,
      defaultSelected: true,
      totalBytes: 40,
    },
    {
      key: "other",
      name: "other",
      status: "push",
      note: { kind: "metadata" },
      selectable: true,
      defaultSelected: true,
      totalBytes: 200,
    },
  ];

  it("父子行同批且上级在前，批次按父级字节切分", () => {
    expect(chunkDataSyncRows(rows, undefined)).toEqual([[rows[0], rows[1], rows[2]]]);
    const batches = chunkDataSyncRows(rows, 150);
    expect(batches.map((batch) => batch.map((row) => row.key))).toEqual([
      ["parent", "child"],
      ["other"],
    ]);
    // 只选子技能时，也要跟随上层父级组头放在同一批（父级未选中不写入）。
    expect(
      chunkDataSyncRows([rows[1]], 150, rows).map((batch) => batch.map((row) => row.key)),
    ).toEqual([["child"]]);
  });

  it("分类三态与设备结果汇总", () => {
    const selectable = rows;
    expect(resolveDataSyncCheckState(selectable, new Set())).toBe(false);
    expect(resolveDataSyncCheckState(selectable, new Set(["parent"]))).toBe("indeterminate");
    expect(resolveDataSyncCheckState(selectable, new Set(["parent", "child", "other"]))).toBe(true);
    expect(aggregateDeviceSyncResult([{ succeeded: 1, failed: 0 }])).toBe("success");
    expect(
      aggregateDeviceSyncResult([
        { succeeded: 1, failed: 0 },
        { succeeded: 0, failed: 2 },
      ]),
    ).toBe("partial");
    expect(aggregateDeviceSyncResult([{ succeeded: 0, failed: 1 }])).toBe("failed");
  });
});

describe("marketplace 插件投影", () => {
  const marketplace = {
    id: "m1",
    name: "Market",
    source: { source: "github", repo: "org/repo", ref: "main" },
    pluginCount: 1,
  };

  it("来源计划：官方 / 网络 / 本地目录 / 不支持", () => {
    expect(resolveMarketplaceSourcePlan({ ...marketplace, isOfficial: true })).toEqual({
      kind: "official",
    });
    expect(resolveMarketplaceSourcePlan(marketplace)).toEqual({
      kind: "network",
      input: "org/repo#main",
    });
    expect(
      resolveMarketplaceSourcePlan({ ...marketplace, source: { source: "git", url: "https://x" } }),
    ).toEqual({ kind: "network", input: "https://x" });
    expect(
      resolveMarketplaceSourcePlan({ ...marketplace, source: { source: "directory", path: "/x" } }),
    ).toEqual({ kind: "mirror", source: { source: "directory", path: "/x" } });
    expect(
      resolveMarketplaceSourcePlan({ ...marketplace, source: { source: "npm", name: "x" } }),
    ).toEqual({ kind: "unsupported" });
  });

  it("只取 User scope、非官方来源的安装记录，并投影为版本行", () => {
    const overview = {
      marketplaces: [marketplace],
      availablePlugins: [
        { id: "p@m1", name: "p", marketplace: "m1", installed: true, version: "2.0.0" },
      ],
      installedPlugins: [
        {
          id: "p@m1",
          name: "p",
          marketplace: "m1",
          version: "1.0.0",
          enabled: true,
          scope: "user",
        },
        { id: "w@m1", name: "w", marketplace: "m1", enabled: true, scope: "workspace" },
        { id: "official@m1", name: "o", marketplace: "m1", enabled: true, scope: "user" },
      ],
      restorableBuiltins: [],
      diagnostics: [],
      capability: { supported: true },
    };
    const plugins = selectUserMarketplacePlugins(overview, [
      { id: "p@m1", name: "p", marketplace: "m1", enabled: true, source: "marketplace" },
      { id: "official@m1", name: "o", marketplace: "m1", enabled: true, source: "official" },
    ] as never);
    expect(plugins.map((plugin) => plugin.installed.id)).toEqual(["p@m1"]);
    const items = buildMarketplacePluginSyncItems({
      overview: overview as never,
      plugins,
      mirrorBlocked: new Set(),
    });
    expect(items[0]).toMatchObject({
      key: "p@m1",
      versionOnly: true,
      version: "1.0.0",
      latestVersion: "2.0.0",
    });
    const orphaned = selectUserMarketplacePlugins(
      {
        ...overview,
        marketplaces: [],
        installedPlugins: [
          { id: "gone@m1", name: "gone", marketplace: "m1", enabled: true, scope: "user" },
        ],
      } as never,
      [],
    );
    expect(
      buildMarketplacePluginSyncItems({
        overview: { ...overview, marketplaces: [] } as never,
        plugins: orphaned,
        mirrorBlocked: new Set(),
      })[0]?.exportBlockedReason,
    ).toBe("source-removed");
  });
});

describe("Provider 分类投影", () => {
  it("API Key 只显示末 4 位，短 Key 全部掩码", () => {
    expect(maskDataSyncApiKey("sk-test-1234567890abcd")).toBe("••••abcd");
    expect(maskDataSyncApiKey("short")).toBe("••••••••");
    const rows = toDataSyncProviderRows({
      revision: 1,
      providerTemplates: [],
      providerOrder: ["openai", "builtin"],
      providers: [
        {
          providerId: "openai",
          providerName: "OpenAI",
          enabled: true,
          executable: true,
          issues: [],
          personalConfig: {},
          effectiveConfig: {
            api: { baseUrl: "https://api.example.test" },
            access: { apiKey: "sk-test-1234567890abcd" },
          },
          models: [
            {
              modelId: "on",
              enabled: true,
              kind: "candidate",
              builtin: false,
              executable: true,
              selectable: true,
              issues: [],
              effectiveConfig: {},
            },
            {
              modelId: "off",
              enabled: false,
              kind: "candidate",
              builtin: false,
              executable: true,
              selectable: true,
              issues: [],
              effectiveConfig: {},
            },
          ],
        },
        {
          providerId: "builtin",
          providerName: "Builtin",
          enabled: true,
          executable: true,
          issues: [],
          effectiveConfig: {},
          models: [],
        },
      ],
    } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: "openai",
      endpoint: "https://api.example.test",
      models: ["on"],
      maskedApiKey: "••••abcd",
    });
  });

  it("lane 展示态：none / running / never / success / failed", () => {
    expect(resolveDataSyncProvisioningDisplay({ phase: "loading" }, false)).toEqual({
      kind: "loading",
    });
    expect(
      resolveDataSyncProvisioningDisplay({ phase: "ready", status: { lane: "none" } }, false),
    ).toEqual({ kind: "none" });
    expect(
      resolveDataSyncProvisioningDisplay(
        { phase: "ready", status: { lane: "present", running: true } },
        false,
      ),
    ).toEqual({ kind: "running" });
    expect(
      resolveDataSyncProvisioningDisplay(
        { phase: "ready", status: { lane: "present", running: false } },
        false,
      ),
    ).toEqual({ kind: "never" });
    expect(
      resolveDataSyncProvisioningDisplay(
        { phase: "ready", status: { lane: "present", running: false } },
        true,
      ),
    ).toEqual({ kind: "running" });
    expect(
      resolveDataSyncProvisioningDisplay(
        {
          phase: "ready",
          status: { lane: "present", running: false, lastResult: { at: 5, outcome: "success" } },
        },
        false,
      ),
    ).toEqual({ kind: "success", at: 5 });
    expect(
      resolveDataSyncProvisioningDisplay(
        {
          phase: "ready",
          status: {
            lane: "present",
            running: false,
            lastResult: { at: 5, outcome: "failed", errorCode: "target-call-failed" },
          },
        },
        false,
      ),
    ).toEqual({ kind: "failed", at: 5, errorCode: "target-call-failed" });
  });
});

describe("设备投影", () => {
  const snapshot = {
    generation: 1,
    profiles: [
      {
        profileId: "p1",
        sourceServerId: "s1",
        displayName: "dev-box",
        lifecycleState: "active",
        transport: "ssh",
        target: { kind: "ssh", host: "h", port: 22, username: "u" },
        createdAt: 1,
      },
      {
        profileId: "p2",
        sourceServerId: "s2",
        displayName: "laptop",
        lifecycleState: "active",
        transport: "wsl",
        target: { kind: "wsl", distro: "Ubuntu", user: "u" },
        createdAt: 1,
      },
    ],
    servers: [
      { sourceServerId: "s1", displayName: "dev-box", installState: "installed" },
      { sourceServerId: "s2", displayName: "laptop", installState: "installed" },
      { sourceServerId: "s3", displayName: "gone", installState: "uninstalled" },
    ],
    states: [
      { profileId: "p1", sourceServerId: "s1", state: "online", updatedAt: 10 },
      { profileId: "p2", sourceServerId: "s2", state: "retrying", updatedAt: 11 },
    ],
    workspaceHistory: [
      {
        workspacePath: "/w",
        workspaceIdentity: "legacy",
        profileId: "p1",
        sourceServerId: "s1",
        lastOpenedAt: 1,
      },
    ],
  } as unknown as SourceServerManagementSnapshot;

  it("只列已安装且有 active profile 的设备；连接态与连接代际来自快照", () => {
    const devices = buildDataSyncDevices(snapshot);
    expect(devices.map((device) => device.sourceServerId).sort()).toEqual(["s1", "s2"]);
    expect(devices[0]).toMatchObject({
      sourceServerId: "s1",
      name: "dev-box",
      description: "SSH · u@h:22",
      remoteKind: "ssh",
      connection: "online",
      profileId: "p1",
    });
    expect(devices[1]).toMatchObject({ connection: "connecting" });
    expect(isDataSyncDeviceOnline(snapshot, "s1")).toBe(true);
    expect(isDataSyncDeviceOnline(snapshot, "s2")).toBe(false);
    expect(dataSyncConnectionKey(snapshot, "s1")).toBe("online@10");
  });

  it("tab 来源：server identity 直接解析，旧格式回落到 workspace history", () => {
    const history = snapshot.workspaceHistory;
    expect(
      resolveTabSourceServerId(
        {
          workspacePath: "/w",
          workspaceIdentity: "remote:server:3f2504e0-4f89-41d3-9a0c-0305e82c3301:/w",
        },
        history,
      ),
    ).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(
      resolveTabSourceServerId({ workspacePath: "/w", workspaceIdentity: "legacy" }, history),
    ).toBe("s1");
    const tabs = selectTabsOnDevice(
      [
        { workspacePath: "/w", workspaceIdentity: "legacy" } as never,
        { workspacePath: "/other", workspaceIdentity: "legacy" } as never,
      ],
      history,
      "s1",
    );
    expect(tabs).toHaveLength(1);
  });
});

describe("错误与缓存", () => {
  it("method-not-found 识别为 unsupported，其他异常不被猜成缺能力", () => {
    expect(isDataSyncUnsupportedError(new Error("Method not found: listSyncItems"))).toBe(true);
    expect(isDataSyncUnsupportedError({ code: -32601, message: "no method" })).toBe(true);
    expect(isDataSyncUnsupportedError(new Error("ENOENT: config.json"))).toBe(false);
    expect(isDataSyncUnsupportedError("boom")).toBe(false);
  });

  it("哈希缓存只对签名不变的项命中，无签名项不缓存", () => {
    const cache = ensureDataSyncHashCache(new Map(), "mcp");
    const items = [
      item({ key: "a", signature: { fileCount: 1, totalBytes: 2 } }),
      item({ key: "b" }),
    ];
    writeDataSyncHashCache(cache, items, { a: "h1", b: "h2" });
    expect(readDataSyncHashCache(cache, items, ["a", "b"])).toEqual({
      hashes: { a: "h1" },
      missing: ["b"],
    });
    const changed = [item({ key: "a", signature: { fileCount: 2, totalBytes: 2 } })];
    expect(readDataSyncHashCache(cache, changed, ["a"]).missing).toEqual(["a"]);
  });
});

describe("弹窗 store", () => {
  beforeEach(() => resetDataSyncDialogStore());

  it("已有实例只恢复，不替换设备；最小化与结果版本由 store 唯一持有", () => {
    const store = useDataSyncDialogStore.getState();
    store.open({ sourceServerId: "s1", category: "mcp" });
    store.setMinimized(true);
    store.open({ sourceServerId: "s2", category: "skills" });
    let state = useDataSyncDialogStore.getState();
    expect(state.request).toEqual({ sourceServerId: "s1", category: "mcp" });
    expect(state.minimized).toBe(false);
    state.recordResult();
    state = useDataSyncDialogStore.getState();
    expect(state.resultVersion).toBe(1);
    state.close();
    expect(useDataSyncDialogStore.getState()).toMatchObject({
      request: null,
      minimized: false,
      resultVersion: 1,
    });
  });
});

describe("加载与推送真实流程", () => {
  it("加载生成行；CAS 冲突只标记该项，修正基线后可再次写入", async () => {
    const source = service([item({ key: "alpha" }), item({ key: "beta", contentHash: "B1" })], {
      alpha: "A1",
      beta: "B1",
    });
    const target = service(
      [item({ key: "beta", contentHash: "B1" }), item({ key: "gamma", contentHash: "G0" })],
      { beta: "B1", gamma: "G0" },
      [{ key: "gamma", status: "conflict" }],
    );
    const category = adapter(
      (services) => (services as unknown as { mcpSyncService: object }).mcpSyncService as never,
    );
    const sourceServices = accessorWith({ mcpSyncService: source });
    const targetServices = accessorWith({ mcpSyncService: target });
    const sourceCache = ensureDataSyncHashCache(new Map(), "mcp");
    const targetCache = ensureDataSyncHashCache(new Map(), "mcp");

    const loaded = await loadDataSyncCategory({
      category,
      sourceServices,
      targetServices,
      sourceCache,
      targetCache,
      isCurrent: () => true,
    });
    expect(loaded.kind).toBe("ready");
    if (loaded.kind !== "ready") return;
    expect(loaded.rows.map((row) => [row.key, row.status])).toEqual([
      ["alpha", "push"],
      ["beta", "synced"],
    ]);
    const gamma = compareDataSyncItems({
      sourceItems: [item({ key: "gamma", contentHash: "G1" })],
      targetItems: [item({ key: "gamma", contentHash: "G0" })],
      sourceHashes: {},
      targetHashes: {},
    })[0]!;
    expect(gamma.status).toBe("difference");

    const stoppedControl = new Set<string>();
    const outcome = await pushDataSyncCategory({
      category,
      sourceServices,
      targetServices,
      rows: [gamma],
      allRows: [gamma],
      control: {
        setStoppable: (key, stop) => {
          if (stop) stoppedControl.add(key);
          else stoppedControl.delete(key);
        },
      },
      assertAlive: () => undefined,
    });
    expect(outcome).toMatchObject({ succeeded: 0, failed: 1 });
    expect(outcome.itemErrors.gamma).toEqual({ status: "conflict" });
    expect(source.calls.exports).toEqual([["gamma"]]);
    expect(target.calls.imports).toHaveLength(1);

    // 迟到/换代结果抛 StalePushError，调用方丢弃，不覆盖新 session。
    await expect(
      pushDataSyncCategory({
        category,
        sourceServices,
        targetServices,
        rows: [gamma],
        allRows: [gamma],
        control: { setStoppable: () => undefined },
        assertAlive: () => {
          throw new StalePushError();
        },
      }),
    ).rejects.toBeInstanceOf(StalePushError);
  });

  it("旧 Server 缺方法时分类 unsupported，不是空列表", async () => {
    const unsupportedService = {
      listSyncItems: async () => {
        throw new Error("Method not found: listSyncItems");
      },
    };
    const category = adapter(() => unsupportedService as never);
    const loaded = await loadDataSyncCategory({
      category,
      sourceServices: accessorWith({ mcpSyncService: unsupportedService }),
      targetServices: accessorWith({ mcpSyncService: unsupportedService }),
      sourceCache: ensureDataSyncHashCache(new Map(), "mcp"),
      targetCache: ensureDataSyncHashCache(new Map(), "mcp"),
      isCurrent: () => true,
    });
    expect(loaded).toEqual({ kind: "unsupported" });
  });

  it("换代后的迟到结果被丢弃", async () => {
    const category = adapter(() => ({ listSyncItems: async () => ({ items: [] }) }) as never);
    const loaded = await loadDataSyncCategory({
      category,
      sourceServices: accessorWith({}),
      targetServices: accessorWith({}),
      sourceCache: ensureDataSyncHashCache(new Map(), "mcp"),
      targetCache: ensureDataSyncHashCache(new Map(), "mcp"),
      isCurrent: () => false,
    });
    expect(loaded).toEqual({ kind: "stale" });
  });
});
