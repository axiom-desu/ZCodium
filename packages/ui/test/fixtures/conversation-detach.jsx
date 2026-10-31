import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/App.js";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { StoreProvider } from "../../src/store/StoreProvider.js";
import { TabStoreProvider, useTabStoreApi } from "../../src/store/TabStoreProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { useRemoteWorkspaceSessionStore } from "../../src/store/remoteWorkspaceSessionStore.js";
import { useConversationWorkspaceActions } from "../../src/root/useConversationWorkspaceActions.js";
import { consumeV4ComposerDraftWorkspaceTransferRequest } from "../../src/v4/composer/composerDraftWorkspaceTransfer.js";

const fixture = (window.detachFixture = { ensures: 0, navigations: [], errors: [], calls: [] });
const noop = () => {};
const noopSub = Object.assign(() => noopSub, { dispose() {} });
function makeService(name) {
  return new Proxy(function () {}, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      if (key === "then") return undefined;
      if (String(key).startsWith("on") || key === "subscribe") return noopSub;
      const child = makeService(`${name}.${String(key)}`);
      Reflect.set(target, key, child);
      return child;
    },
    apply() {
      return Promise.resolve(undefined);
    },
  });
}
const pending = () => new Promise(() => {});
const agent = makeService("agent");
for (const method of [
  "helloConversationV4",
  "initializeConversationV4",
  "subscribeSessionsIndexV4",
  "resyncSessionsIndexV4",
])
  agent[method] = pending;
const settings = { recentProjects: [], lastWorkspaceSession: [], lastActiveTabIndex: 0 };
let barrier;
fixture.arm = (fail = false) => {
  let release;
  barrier = {
    fail,
    started: false,
    done: false,
    promise: new Promise((resolve) => {
      release = resolve;
    }),
  };
  fixture.barrier = barrier;
  fixture.release = release;
};
const serviceValues = {
  systemService: {
    async info() {
      return { homedir: "/fixture/home", platform: "linux" };
    },
  },
  broadcastService: { onMessage: noopSub, async send() {} },
  zcodeAgentService: agent,
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
      fixture.ensures++;
      const held = barrier && !barrier.started ? barrier : null;
      if (held) {
        held.started = true;
        await held.promise;
        held.done = true;
        if (held.fail) throw new Error("stale-detach-error");
      }
      return { path: "/fixture/conversation" };
    },
  },
};
const services = new Proxy(serviceValues, {
  get(target, key) {
    if (!(key in target)) target[key] = makeService(String(key));
    return target[key];
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
    get: (target, key) =>
      key in target ? target[key] : String(key).startsWith("on") ? () => noop : async () => null,
  },
);

function Harness() {
  const tabs = useTabStoreApi();
  const [scope, setScope] = useState({ workspacePath: "/fixture/local" });
  const [mounted, setMounted] = useState(true);
  const [error, setError] = useState(null);
  fixture.error = error;
  fixture.setError = setError;
  fixture.setMounted = setMounted;
  fixture.setScope = (next) => {
    if (next.remoteSessionId) {
      useRemoteWorkspaceSessionStore
        .getState()
        .registerSession({ sessionId: next.remoteSessionId, target: next.remoteTarget, services });
      if (next.workspaceIdentity)
        useRemoteWorkspaceSessionStore
          .getState()
          .bindWorkspaceIdentity(next.workspaceIdentity, next.remoteSessionId);
    }
    tabs.getState().addTab(next.workspacePath, next);
    setScope(next);
  };
  fixture.active = () => ({
    path: tabs.getState().activeWorkspacePath,
    identity: tabs.getState().activeWorkspaceIdentity,
  });
  fixture.consumeTransfer = (source) =>
    consumeV4ComposerDraftWorkspaceTransferRequest({
      sourceWorkspacePath: source.workspacePath,
      sourceWorkspaceIdentity: source.workspaceIdentity,
      targetWorkspacePath: "/fixture/conversation",
    });
  const actions = useConversationWorkspaceActions({
    services,
    addTab: (...args) => {
      fixture.navigations.push(args);
      return tabs.getState().addTab(...args);
    },
    setWorkspaceActionError: setError,
  });
  fixture.resolve = actions.handleResolveConversationWorkspace;
  fixture.createConversation = actions.handleCreateConversationTask;
  return (
    <>
      <output data-testid="detach-harness-ready">{scope.workspacePath}</output>
      {error ? <p role="alert">{error}</p> : null}
      {mounted ? (
        <App
          services={services}
          workspaceAbsPath={scope.workspacePath}
          workspaceIdentity={scope.workspaceIdentity}
          workspaceRemoteSessionId={scope.remoteSessionId}
          isDesktop
          isMacDesktop={false}
          isWindowsDesktop={false}
          supportsEmbeddedBrowser={false}
          onCreateTask={noop}
          onCreateConversationTask={actions.handleCreateConversationTask}
          onResolveConversationWorkspace={actions.handleResolveConversationWorkspace}
          onOpenWorkspace={noop}
          onOpenFolderFromWorkspaceMenu={noop}
          onCreateScratchWorkspace={noop}
          onReturnToWorkspace={noop}
          remoteWorkspaceErrorByWorkspaceKey={{}}
          reconnectingRemoteWorkspaceKeys={[]}
          allowRemoteWorkspace={false}
          onConnectRemote={noop}
          onSelectRemoteProject={noop}
          onCancelRemoteProject={noop}
          onReconnectRemoteWorkspace={noop}
        />
      ) : null}
    </>
  );
}
createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <ServiceProvider services={services}>
        <PlatformProvider platform={platform}>
          <StoreProvider broadcastService={services.broadcastService}>
            <TabStoreProvider>
              <Harness />
            </TabStoreProvider>
          </StoreProvider>
        </PlatformProvider>
      </ServiceProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
