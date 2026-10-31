import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginUiLauncherItems } from "../../src/plugin-ui/components/PluginUiLauncherItems.js";
import { PluginUiWorkspaceProvider } from "../../src/plugin-ui/adapters/PluginUiProviders.js";
import { PluginStorePage } from "../../src/settings/PluginStorePage.js";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

const query = new URLSearchParams(location.search);
const locale = query.get("locale") || "en-US";
const configFallback = query.get("fallback") === "1";
const official = "zcode-plugins-official";
const pluginId = `documents@${official}`;
const pendingByWorkspace = new Map();
const state = (window.marketplaceFixture = {
  reads: [],
  updates: [],
  descriptions: [],
  opened: [],
  releaseA() {
    for (const resolve of pendingByWorkspace.get("/fixture/project-a") ?? []) resolve();
    pendingByWorkspace.delete("/fixture/project-a");
  },
});
function gate(workspacePath) {
  state.reads.push(workspacePath);
  if (!workspacePath.endsWith("project-a")) return Promise.resolve();
  return new Promise((resolve) => {
    const pending = pendingByWorkspace.get(workspacePath) ?? [];
    pending.push(resolve);
    pendingByWorkspace.set(workspacePath, pending);
  });
}
const workspaceLabel = (workspacePath) => (workspacePath.endsWith("project-b") ? "B" : "A");
function pluginInfo(workspacePath) {
  const label = workspaceLabel(workspacePath);
  return {
    id: pluginId,
    name: "documents",
    description: `${label} workspace documents`,
    version: "0.2.0",
    enabled: true,
    source: "cache",
    marketplace: official,
    skillRootCount: 1,
    commandRootCount: 0,
    mcpServerNames: ["documents"],
    rootPath: `/plugins/${label}/documents`,
    uiSurfaces: [
      {
        pluginId,
        pluginName: "documents",
        id: "documents",
        title: { "en-US": `${label} Docs`, "zh-CN": `${label} 文档` },
        server: "documents",
        resourceUri: "ui://documents/panel.html",
        availability: "session",
      },
    ],
  };
}
function overview() {
  return {
    marketplaces: [
      {
        id: official,
        name: "ZCodium",
        source: { source: "bundled" },
        isOfficial: true,
        pluginCount: 1,
      },
    ],
    availablePlugins: [
      {
        id: pluginId,
        name: "documents",
        marketplace: official,
        version: "0.2.0",
        installed: true,
        componentTypes: ["ui"],
      },
    ],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
  };
}
const services = {
  clientConfigService: {
    async getSnapshot() {
      return {
        pluginStoreOrder: null,
        zsrcUrl: null,
        uiPluginRecommendations: configFallback
          ? []
          : [
              { pluginId, surfaceId: "documents" },
              { pluginId, surfaceId: "secondary" },
            ],
      };
    },
  },
  pluginManagementService: {
    async listPlugins({ workspacePath }) {
      await gate(workspacePath);
      return { plugins: [pluginInfo(workspacePath)], diagnostics: [] };
    },
    async getPluginsOverview({ workspacePath }) {
      await gate(workspacePath);
      return overview();
    },
    async describePlugin(params) {
      state.descriptions.push(params);
      return { components: [], diagnostics: [], metadata: { version: "0.2.0" } };
    },
    async updatePluginMarketplace(params) {
      state.updates.push(params.marketplace ?? "all");
      return { diagnostics: [] };
    },
    async installPlugin() {
      return { diagnostics: [] };
    },
    async restoreBuiltinPlugin() {
      return { diagnostics: [] };
    },
    async setPluginEnabled({ pluginId: id, enabled }) {
      return { plugin: { ...pluginInfo("/fixture/project-b"), id, enabled }, enabled };
    },
    async addPluginMarketplace() {},
    async removePluginMarketplace() {},
    async uninstallPlugin() {},
  },
  skillsService: {
    async listSkills() {
      return { skills: [] };
    },
    async refresh() {},
  },
  zcodeSessionService: { async closeSession() {} },
  pluginUiBridgeService: {
    async listSurfaces({ workspacePath }) {
      const label = workspaceLabel(workspacePath);
      return [pluginInfo(workspacePath).uiSurfaces[0]].map((surface) => ({
        ...surface,
        title: { "en-US": `${label} Docs`, "zh-CN": `${label} 文档` },
      }));
    },
  },
  zcodeTaskService: { onDynamicWorkspaceEvent: () => () => ({ dispose() {} }) },
  zcodeAgentService: {
    onDynamicPluginUiToolResult: () => () => ({ dispose() {} }),
  },
};
function Fixture() {
  const [target, setTarget] = useState("a");
  const workspacePath = `/fixture/project-${target}`;
  return (
    <div className="space-y-4 p-4">
      <button
        type="button"
        data-testid="switch-workspace"
        onClick={() => setTarget((current) => (current === "a" ? "b" : "a"))}
      >
        Switch workspace
      </button>
      <button type="button" data-testid="release-late-a" onClick={() => state.releaseA()}>
        Release late A
      </button>
      <section data-testid="recommendation-launcher">
        <PluginUiWorkspaceProvider
          onOpenSidePane={(request) => {
            state.opened.push(request);
          }}
        >
          <PluginUiLauncherItems
            workspacePath={workspacePath}
            workspaceIdentity={workspacePath}
            sessionId={`session-${target}`}
            onOpenPluginUi={(request) => state.opened.push(request)}
            itemClassName="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left"
          />
        </PluginUiWorkspaceProvider>
      </section>
      <PluginStorePage
        workspacePath={workspacePath}
        workspaceIdentity={workspacePath}
        sessionId={`session-${target}`}
        onCreateTask={() => {}}
        onManageInstalled={() => {}}
      />
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  <PlatformProvider
    platform={{
      platform: "linux",
      pluginSandbox: {
        getOwnerWebContentsId: async () => 1,
        disposeSandbox: async () => {},
        consumeUserGesture: async () => true,
        onPorts: () => () => {},
      },
    }}
  >
    <ServiceProvider services={services}>
      <TabStoreProvider>
        <TooltipProvider>
          <ZCodeIntlProvider initialLocale={locale}>
            <Fixture />
          </ZCodeIntlProvider>
        </TooltipProvider>
      </TabStoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
