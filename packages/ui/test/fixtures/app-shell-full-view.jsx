import { createRoot } from "react-dom/client";
import { App } from "../../src/App.js";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { StoreProvider } from "../../src/store/StoreProvider.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import {
  peekTaskSidePaneFullView,
  saveTaskSidePaneMemoryState,
} from "../../src/lib/taskSidePaneMemory.js";
import { usePaneLayoutStore } from "../../src/v4/paneLayoutStore.js";
import { useWorkbenchPaneCount } from "../../src/app-shell/useWorkbenchPaneCount.js";

const workspacePath = "/fixture/app-shell";
const fixture = (window.appShellFixture = {
  calls: [],
  paneCount: 1,
  splitPane: () => {},
  resetPanes: () => {},
  peekFullView: () => null,
});
const noopSub = Object.assign(() => noopSub, { dispose() {} });
const events = new Map();
function makeService(name) {
  return new Proxy(function () {}, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      if (key === "then") return undefined;
      if (String(key).startsWith("on") || key === "subscribe" || key === "onMessage") {
        return noopSub;
      }
      const child = makeService(`${name}.${String(key)}`);
      Reflect.set(target, key, child);
      return child;
    },
    apply() {
      fixture.calls.push(`call:${name}`);
      return Promise.resolve(undefined);
    },
  });
}
const pending = () => new Promise(() => {});
const agentService = makeService("zcodeAgentService");
agentService.helloConversationV4 = pending;
agentService.initializeConversationV4 = pending;
agentService.subscribeSessionsIndexV4 = pending;
agentService.resyncSessionsIndexV4 = pending;
agentService.unsubscribeSessionsIndexV4 = async () => ({});
const settings = { recentProjects: [], lastWorkspaceSession: [], lastActiveTabIndex: 0 };
const serviceValues = {
  broadcastService: { onMessage: noopSub, async send() {} },
  zcodeAgentService: agentService,
  settingService: {
    async get() {
      return structuredClone(settings);
    },
    async update(patch) {
      Object.assign(settings, patch);
    },
    onDidChange: noopSub,
  },
  modelSelectionService: {
    onDidChange: noopSub,
    async getView() {
      return { revision: 1, providers: [] };
    },
  },
  providerSettingsService: {
    onDidChange: noopSub,
    async getView() {
      return { revision: 1, providers: [], providerTemplates: [], providerOrder: [] };
    },
  },
  codingPlanSubscriptionService: {
    async getDynamicWorkflowClientConfig() {
      return { enabled: false };
    },
  },
  fileService: {
    async ensureConversationWorkspace() {
      return { path: workspacePath };
    },
  },
};
const services = new Proxy(serviceValues, {
  get(target, key) {
    return key in target ? target[key] : makeService(String(key));
  },
});
const platform = new Proxy(
  {
    getDesktopZoomLevel: async () => ({ zoomLevel: 0 }),
    getUpdateState: async () => ({ kind: "idle" }),
    getWindowControlsOverlayMetrics: () => ({ leftPaddingPx: 0, rightPaddingPx: 0 }),
    getDesktopWindowChromeState: async () => null,
  },
  {
    get(target, key) {
      if (key in target) return target[key];
      if (String(key).startsWith("on")) {
        const listener = (next) => {
          events.set(key, next);
          return () => events.delete(key);
        };
        Reflect.set(target, key, listener);
        return listener;
      }
      const handler = async () => null;
      Reflect.set(target, key, handler);
      return handler;
    },
  },
);
fixture.openWorkspace = (path) => events.get("onOpenWorkspacePath")?.(path);
fixture.peekFullView = () => peekTaskSidePaneFullView(workspacePath, null);
fixture.splitPane = () =>
  usePaneLayoutStore.getState().splitPane("workspace-main", "right", {
    workspacePath,
  });
fixture.resetPanes = () => usePaneLayoutStore.getState().resetToPrimaryPane();
saveTaskSidePaneMemoryState(workspacePath, {
  isSidePaneCollapsed: false,
  sidePaneState: {
    tabs: [
      {
        id: "fixture-board-tab",
        type: "whiteboard",
        boardId: "fixture-board",
        ownerTaskId: null,
        workspaceKey: workspacePath,
        openedAt: 1,
      },
    ],
    activeTabId: "fixture-board-tab",
  },
});

function PaneCountProbe() {
  fixture.paneCount = useWorkbenchPaneCount();
  return <span data-testid="app-shell-pane-count">{fixture.paneCount}</span>;
}
const noop = () => {};
createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <ServiceProvider services={services}>
        <PlatformProvider platform={platform}>
          <StoreProvider broadcastService={services.broadcastService}>
            <TabStoreProvider>
              <App
                services={services}
                workspaceAbsPath={workspacePath}
                isDesktop
                isMacDesktop={false}
                isWindowsDesktop={false}
                supportsEmbeddedBrowser={false}
                onCreateTask={noop}
                onCreateConversationTask={noop}
                onResolveConversationWorkspace={() => workspacePath}
                onOpenWorkspace={noop}
                onOpenFolderFromWorkspaceMenu={noop}
                onCreateScratchWorkspace={noop}
                onReturnToWorkspace={noop}
                allowRemoteWorkspace={false}
                onConnectRemote={noop}
                onSelectRemoteProject={noop}
                onCancelRemoteProject={noop}
                onReconnectRemoteWorkspace={noop}
              />
              <PaneCountProbe />
            </TabStoreProvider>
          </StoreProvider>
        </PlatformProvider>
      </ServiceProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
