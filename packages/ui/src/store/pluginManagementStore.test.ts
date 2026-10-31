import { describe, expect, it } from "vitest";
import type { IPluginManagementService } from "@zcode/services";
import type {
  ZCodePluginInfo,
  ZCodePluginsOverviewResult,
  ZCodePluginsListResult,
} from "@zcode/shared";
import { createPluginManagementStore } from "./pluginManagementStore.js";
import { isItemBusy, type StorePluginItem } from "@/settings/pluginStoreListing.js";

const official = "zcode-plugins-official";
const plugin = (workspace: string, id = "documents@zcode-plugins-official"): ZCodePluginInfo => ({
  id,
  name: id.split("@")[0]!,
  enabled: true,
  source: "cache",
  marketplace: official,
  skillRootCount: 0,
  commandRootCount: 0,
  mcpServerNames: [],
  rootPath: `/plugins/${workspace}/${id}`,
  description: workspace,
});
const list = (workspace: string): ZCodePluginsListResult => ({
  plugins: [plugin(workspace)],
  diagnostics: [],
});
const overview = (): ZCodePluginsOverviewResult => ({
  marketplaces: [],
  availablePlugins: [],
  installedPlugins: [],
  restorableBuiltins: [],
  diagnostics: [],
  capability: { supported: true },
});
function deferred<T>() {
  const value = Promise.withResolvers<T>();
  return { promise: value.promise, resolve: value.resolve, reject: value.reject };
}
function service(overrides: Record<string, unknown> = {}) {
  return {
    listPlugins: async ({ workspacePath }: { workspacePath: string }) => list(workspacePath),
    getPluginsOverview: async () => overview(),
    ...overrides,
  } as unknown as IPluginManagementService;
}
const init = (
  store: ReturnType<typeof createPluginManagementStore>,
  workspacePath: string,
  pluginService: IPluginManagementService,
  remoteSessionId: string | null = null,
) =>
  store.getState().initialize({
    workspacePath,
    workspaceIdentity: workspacePath,
    remoteSessionId,
    configScope: "user",
    pluginService,
  });

describe("plugin management scoped projection", () => {
  it("drops a late A list response after switching to a same plugin id in B", async () => {
    const a = deferred<ZCodePluginsListResult>();
    const b = deferred<ZCodePluginsListResult>();
    const pluginService = service({
      listPlugins: ({ workspacePath }: { workspacePath: string }) =>
        workspacePath === "/a" ? a.promise : b.promise,
      getPluginsOverview: async () => overview(),
    });
    const store = createPluginManagementStore(pluginService);
    const initializeA = init(store, "/a", pluginService);
    await Promise.resolve();
    const initializeB = init(store, "/b", pluginService);
    b.resolve(list("/b"));
    await initializeB;
    expect(store.getState().plugins[0]?.description).toBe("/b");
    a.resolve(list("/a"));
    await initializeA;
    expect(store.getState().workspacePath).toBe("/b");
    expect(store.getState().plugins[0]?.description).toBe("/b");
  });

  it("isolates the same path by remoteSessionId so a released generation cannot overwrite", async () => {
    const pending = Array.from({ length: 2 }, () => deferred<ZCodePluginsListResult>());
    let calls = 0;
    const pluginService = service({
      listPlugins: async () => pending[calls++]!.promise,
      getPluginsOverview: async () => overview(),
    });
    const store = createPluginManagementStore(pluginService);
    const initializeA = store.getState().initialize({
      workspacePath: "/same",
      workspaceIdentity: "remote:ssh:host:22:user:/same",
      remoteSessionId: "generation-a",
      configScope: "user",
      pluginService,
    });
    await Promise.resolve();
    const initializeB = store.getState().initialize({
      workspacePath: "/same",
      workspaceIdentity: "remote:ssh:host:22:user:/same",
      remoteSessionId: "generation-b",
      configScope: "user",
      pluginService,
    });
    await Promise.resolve();
    pending[1]!.resolve(list("/b"));
    await initializeB;
    expect(store.getState().remoteSessionId).toBe("generation-b");
    expect(store.getState().plugins[0]?.description).toBe("/b");
    pending[0]!.resolve(list("/a"));
    await initializeA;
    expect(store.getState().remoteSessionId).toBe("generation-b");
    expect(store.getState().plugins[0]?.description).toBe("/b");
  });

  it("keeps busy per plugin and never lets A's late install clear B's busy/error", async () => {
    const installA = deferred<{ diagnostics: [] }>();
    const installB = deferred<{ diagnostics: [] }>();
    const pluginService = service({
      installPlugin: ({ workspacePath }: { workspacePath: string }) =>
        workspacePath === "/a" ? installA.promise : installB.promise,
    });
    const store = createPluginManagementStore(pluginService);
    await init(store, "/a", pluginService);
    const operationA = store.getState().installPlugin("documents", official, pluginService);
    await Promise.resolve();
    const documents: StorePluginItem = {
      id: "documents@zcode-plugins-official",
      name: "documents",
      marketplace: official,
      installed: false,
      restorable: false,
      orphaned: false,
    };
    const other: StorePluginItem = { ...documents, id: "pdf@zcode-plugins-official", name: "pdf" };
    expect(isItemBusy(documents, store.getState())).toBe(true);
    expect(isItemBusy(other, store.getState())).toBe(false);

    await init(store, "/b", pluginService);
    expect(store.getState().activeOperations).toEqual([]);
    const operationB = store.getState().installPlugin("documents", official, pluginService);
    await Promise.resolve();
    installB.reject(new Error("B failed"));
    expect(await operationB).toBe(false);
    expect(store.getState().error).toBe("B failed");
    expect(store.getState().activeOperations).toEqual([]);

    installA.resolve({ diagnostics: [] });
    await operationA;
    expect(store.getState().workspacePath).toBe("/b");
    expect(store.getState().error).toBe("B failed");
    expect(store.getState().activeOperations).toEqual([]);
  });

  it("discards A describe after switching to B even when plugin ids match", async () => {
    const describeA = deferred<{
      components: [];
      diagnostics: [];
      metadata: { version: string };
    }>();
    const describeB = deferred<{
      components: [];
      diagnostics: [];
      metadata: { version: string };
    }>();
    const pluginService = service({
      describePlugin: ({ workspacePath }: { workspacePath: string }) =>
        workspacePath === "/a" ? describeA.promise : describeB.promise,
    });
    const store = createPluginManagementStore(pluginService);
    await init(store, "/a", pluginService);
    const requestA = store
      .getState()
      .describePlugin("documents@x", "documents", official, pluginService);
    await Promise.resolve();
    await init(store, "/b", pluginService);
    const requestB = store
      .getState()
      .describePlugin("documents@x", "documents", official, pluginService);
    await Promise.resolve();
    describeB.resolve({ components: [], diagnostics: [], metadata: { version: "B" } });
    await requestB;
    expect(store.getState().describeCache[documentsId]?.data?.metadata).toEqual({ version: "B" });
    describeA.resolve({ components: [], diagnostics: [], metadata: { version: "A" } });
    await requestA;
    expect(store.getState().describeCache[documentsId]?.data?.metadata).toEqual({ version: "B" });
  });
});
const documentsId = "documents@x";
