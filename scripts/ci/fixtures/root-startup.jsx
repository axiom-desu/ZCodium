import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "../../../packages/ui/src/Root.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "restored";
const modelMode = params.get("models") || "ready";
window.startupFixture = {
  calls: [],
  forbidden: [],
  modelReads: 0,
  directoryCreates: 0,
  directorySelections: 0,
  platformListeners: {},
};
const fixture = window.startupFixture;
const settings = {
  recentProjects: [],
  lastWorkspaceSession:
    mode === "restored" ? [{ kind: "local", workspacePath: "/fixture/restored" }] : [],
  lastActiveTabIndex: 0,
  // 旧设置残留必须不会再启动 Renderer 账号恢复或 family 迁移。
  providerFamilyDomain: "zai",
  providerFamilyDomainMigrated: false,
};
const forbidden = (name) => {
  fixture.forbidden.push(name);
  throw new Error(`Unexpected IO: ${name}`);
};
const events = new Map();
const modelView = { revision: 1, providers: [] };
const serviceValues = {
  broadcastService: { onMessage: () => ({ dispose() {} }), async send() {} },
  settingService: {
    async get() {
      fixture.calls.push("settings.get");
      return structuredClone(settings);
    },
    async update(patch) {
      fixture.calls.push("settings.update");
      Object.assign(settings, patch);
    },
  },
  modelSelectionService: {
    onDidChange: () => ({ dispose() {} }),
    async getView() {
      fixture.modelReads++;
      if (modelMode === "pending")
        return new Promise((resolve) => {
          fixture.resolveModels = () => resolve(modelView);
        });
      if (modelMode === "failure" && fixture.modelReads === 1)
        throw new Error("Fixture model settings failure");
      return modelView;
    },
  },
  providerSettingsService: {
    onDidChange: () => ({ dispose() {} }),
    async getView() {
      fixture.calls.push("provider.getView");
      return { revision: 1, providers: [], providerTemplates: [], providerOrder: [] };
    },
  },
  codingPlanSubscriptionService: {
    async getDynamicWorkflowClientConfig() {
      fixture.calls.push("workflow.localConfig");
      return { enabled: true };
    },
  },
  zcodeAgentService: {
    async syncAppRuntimePreferences() {
      fixture.calls.push("agent.preferences");
    },
  },
  botsService: {},
  conversationShareService: {},
  // 3.16 起根壳挂载项目侧栏，启动期允许只读项目元数据；
  // 写路径（创建/准备/归属变更）仍一律禁止，由各方法触发 forbidden。
  projectService: new Proxy(
    {
      async readTree() {
        fixture.calls.push("project.readTree");
        return { projects: [], tasks: [] };
      },
      async readProjects() {
        fixture.calls.push("project.readProjects");
        return [];
      },
    },
    {
      get: (target, key) =>
        key in target ? target[key] : (..._args) => forbidden(`project.${String(key)}`),
    },
  ),
  zcodeTaskService: new Proxy(
    { onDynamicWorkspaceEvent: () => ({ dispose() {} }) },
    {
      get: (target, key) =>
        key in target ? target[key] : (..._args) => forbidden(`task.${String(key)}`),
    },
  ),
  credentialService: new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (..._args) =>
          forbidden(`credential.${String(key)}`),
    },
  ),
  fileService: {
    async ensureConversationWorkspace() {
      fixture.directoryCreates++;
      if (mode === "directory-failure" && fixture.directoryCreates === 1)
        throw new Error("Fixture private directory error");
      if (mode === "directory-pending")
        return new Promise((resolve) => {
          fixture.resolveDirectory = () => resolve({ path: "/fixture/default" });
        });
      return { path: "/fixture/default" };
    },
  },
};
const services = new Proxy(serviceValues, {
  get(target, key) {
    if (key in target) return target[key];
    return forbidden(`service.${String(key)}`);
  },
});
const platform = new Proxy(
  {
    async selectDirectory() {
      fixture.directorySelections++;
      return fixture.directorySelections === 1 ? null : "/fixture/chosen";
    },
    async activateOrSetWorkspace() {
      return { status: "updated" };
    },
    async setApplicationLocale() {},
    async setNativeTheme() {},
    async setTitleBarTheme() {},
    syncWindowTabs() {},
    syncWindowUnreadCount() {},
    syncActiveTaskSession() {},
  },
  {
    get(target, key) {
      if (/oauth|jwt|login/i.test(String(key))) return forbidden(`platform.${String(key)}`);
      if (key in target) return target[key];
      if (String(key).startsWith("on"))
        return (listener) => {
          events.set(key, listener);
          fixture.platformListeners[key] = true;
          return () => {
            events.delete(key);
            delete fixture.platformListeners[key];
          };
        };
      return undefined;
    },
  },
);
fixture.openWorkspace = (path) => events.get("onOpenWorkspacePath")?.(path);
sessionStorage.setItem("zcode:auth:jwt-invalid-restart", "1");
function Fixture() {
  const [mounted, setMounted] = useState(true);
  fixture.unmount = () => setMounted(false);
  return mounted ? (
    <Root
      services={services}
      platform={platform}
      isDesktop={params.get("platform") !== "web"}
      restoreSession={!mode.startsWith("directory-")}
      initialWorkspaceAbsPath={mode === "initial" ? "/fixture/initial" : undefined}
      allowRemoteWorkspace={false}
    />
  ) : (
    <p>Unmounted</p>
  );
}
createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") || "en-US"}>
    <Fixture />
  </ZCodeIntlProvider>,
);
