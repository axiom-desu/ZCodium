import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { applyTheme } from "../../src/useTheme.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { StoreProvider } from "../../src/store/StoreProvider.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { useRemoteWorkspaceSessionStore } from "../../src/store/remoteWorkspaceSessionStore.js";
import { FileManagerPane } from "../../src/WorkspaceFileTree.js";
import { AnimatedSidePanePanel } from "../../src/app-shell/AnimatedSidePanePanel.js";
import { ResizablePanel, ResizablePanelGroup } from "../../src/components/ui/resizable.js";
import { navigateCodeViewerSidePane } from "../../src/lib/workspaceSidePane.js";
import { createCodeViewerSourceForWorkspaceFile } from "../../src/workspace-file-tree/model.js";

// 文件管理器导航面板的浏览器夹具（spec：.agents/specs/file-manager-navigation-pane.md）。
// 生产 FileManagerPane / PreviewPane / WorkspaceFileTree 原样挂载；夹具只提供 workspace 外壳、
// 临时目录的 FileService 适配器（loopback）与可断言的导航记录。
const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") || "light");

const initialTarget = {
  workspacePath: params.get("workspace") || "",
  workspaceIdentity: params.get("identity") || undefined,
  workspaceRemoteSessionId: params.get("remoteSession") || undefined,
};

const fixture = (window.fileManagerFixture = {
  target: initialTarget,
  sourcePath: null,
  navigateCount: 0,
  delayByWorkspace: {},
  narrow: false,
  setTarget: () => {},
  setNarrow: () => {},
  clearPrefs: () => {},
});

function delayForPath(path) {
  let matchedDelay = 0;
  for (const [workspace, delay] of Object.entries(fixture.delayByWorkspace)) {
    if (path === workspace || path.startsWith(`${workspace}/`)) {
      matchedDelay = Math.max(matchedDelay, delay);
    }
  }
  return matchedDelay;
}

async function fetchFixture(path, delay = 0) {
  const response = await fetch(path);
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

// 临时 workspace 的真实目录由夹具 HTTP 服务读取，renderer 侧只经 FileService 公共入口访问。
const fileService = {
  readdir: ({ path }) =>
    fetchFixture(`/fs/readdir?path=${encodeURIComponent(path)}`, delayForPath(path)),
  readTextFile: ({ path }) =>
    fetchFixture(`/fs/read?path=${encodeURIComponent(path)}`, delayForPath(path)),
};
const fileWatcherService = {
  watch: async () => ({ id: "fixture-watcher" }),
  unwatch: async () => {},
  disposeAll: () => {},
  onDynamicChange: () => ({ dispose: () => {} }),
};
const gitService = {
  refresh: async () => ({
    summary: { isGitAvailable: false, isRepository: false },
    identity: null,
    unstagedChanges: [],
    stagedChanges: [],
    branchComparison: null,
  }),
  getIgnoredPaths: async () => [],
};

const stubServices = new Proxy(
  { fileService, fileWatcherService, gitService },
  { get: (target, key) => (key in target ? target[key] : undefined) },
);
const stubPlatform = new Proxy(
  { getInstalledEditors: async () => [], onSettingsChanged: () => () => {} },
  {
    get: (target, key) =>
      key in target ? target[key] : String(key).startsWith("on") ? () => () => {} : () => undefined,
  },
);
const noopBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

// 远端 workspace 的服务由生产 remoteWorkspaceSessionStore 注入；测试用 loopback 适配器，
// 不连外部主机，同时保持与真实远程会话相同的解析路径。
function registerFixtureRemoteSession(remoteSessionId) {
  if (!remoteSessionId) return;
  const store = useRemoteWorkspaceSessionStore.getState();
  if (store.sessionsById[remoteSessionId]) return;
  store.registerSession({ sessionId: remoteSessionId, services: stubServices });
}
registerFixtureRemoteSession(initialTarget.workspaceRemoteSessionId);

function Shell() {
  const [target, setTarget] = useState(initialTarget);
  const [source, setSource] = useState(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    // 夹具镜面值直接来自渲染期 state，E2E 读到的事实与 React 一致。
    fixture.target = target;
    fixture.setTarget = (nextTarget) => {
      registerFixtureRemoteSession(nextTarget.workspaceRemoteSessionId);
      setTarget(nextTarget);
      // 与生产 navigateCodeViewerSidePane 一致：切 workspace 后仍保留同一个 tab，
      // 但目标 workspace 变化时旧 source 属于旧 Host，必须清空等待用户重新选择文件。
      setSource(null);
    };
    fixture.setNarrow = setNarrow;
    fixture.clearPrefs = () => {
      localStorage.removeItem("zcode-file-manager-navigation-preferences");
    };
  }, [target]);

  const handleNavigate = (nextSource) => {
    // 生产行为：目录行只更新当前 tab 的 source，不新建 tab。
    fixture.navigateCount += 1;
    fixture.sourcePath = nextSource.path ?? null;
    setSource(nextSource);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <div
        data-testid="fixture-pane-host"
        className="flex h-full min-h-0 flex-col"
        style={{ width: narrow ? 360 : 900 }}
      >
        <FileManagerPane
          source={source}
          target={target}
          canOpenLocalFileManager={false}
          onNavigate={handleNavigate}
          onClose={() => {}}
          workspacePath={target.workspacePath}
        />
      </div>
    </div>
  );
}

// 面板集成模式：只挂 code-viewer tab，验证文件管理器嵌在真实 AnimatedSidePanePanel 里，
// 目录行通过生产 navigateCodeViewerSidePane 更新同一个 tab（不新建 tab）。
const fixtureTabId = "code-viewer:fixture";
const noop = () => {};

function PanelShell() {
  const [sidePaneState, setSidePaneState] = useState({
    tabs: [
      {
        id: fixtureTabId,
        type: "code-viewer",
        source: createCodeViewerSourceForWorkspaceFile(
          joinPath(initialTarget.workspacePath, "alpha.md"),
        ),
        sourceKey: "fixture-key",
        ownerTaskId: "fixture-task",
        workspaceKey: initialTarget.workspacePath,
        openedAt: 1,
      },
    ],
    activeTabId: fixtureTabId,
  });
  fixture.panelTabCount = sidePaneState.tabs.length;
  // 渲染期不能把计数清零，否则 setState 后的重渲染会覆盖 E2E 读到的导航次数。
  fixture.panelNavigateCount ??= 0;

  const handleNavigateCodeViewer = (tabId, source) => {
    fixture.panelNavigateCount += 1;
    setSidePaneState((current) => navigateCodeViewerSidePane(current, tabId, source));
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background-alt">
      <ResizablePanelGroup
        layoutId="file-manager-panel-fixture"
        panelIds={["conversation", "browser"]}
      >
        <ResizablePanel id="conversation" defaultSize="60%">
          <div className="h-full" />
        </ResizablePanel>
        <AnimatedSidePanePanel
          services={stubServices}
          isDesktop={false}
          isWindowsDesktop={false}
          isVisible
          sidePaneState={sidePaneState}
          recentClosedSidePaneTabs={[]}
          isBrowserOpen={false}
          workspaceAbsPath={initialTarget.workspacePath}
          activeTaskId="fixture-task"
          sidePaneOwnerId="fixture-task"
          gitState={{}}
          activeGitSourceId="working-tree"
          panelRef={{ current: null }}
          panelElementRef={{ current: null }}
          browserNavigationRequest={null}
          browserRestoreUrls={{}}
          fileChangeFindActiveIndex={0}
          fileChangeFindNavigationRequestId={0}
          fileChangeFindQuery=""
          onFileChangeFindMatchCountChange={noop}
          onCloseCodeViewer={noop}
          onNavigateCodeViewer={handleNavigateCodeViewer}
          onCloseGit={noop}
          onActivateTab={noop}
          onReorderTab={noop}
          onCloseTab={noop}
          onCloseOtherTabs={noop}
          onCloseAllTabs={noop}
          onReopenClosedTab={noop}
          onOpenBrowserTab={noop}
          onOpenWhiteboard={noop}
          onOpenDeveloperTools={noop}
          onOpenTerminalTab={noop}
          onOpenReviewTab={noop}
          onOpenSelectionSideConversation={noop}
          onOpenBrowserUrl={noop}
          onOpenCodeViewer={noop}
          onOpenSubagentSession={noop}
          onRefreshGit={noop}
          onBrowserNavigationRequestHandled={noop}
          onBrowserUrlChange={noop}
          onBrowserPageMetadataChange={noop}
          onSelectGitSource={noop}
          onCloseSidePane={noop}
        />
      </ResizablePanelGroup>
    </div>
  );
}

function joinPath(directory, name) {
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") || "en-US"}>
    <TooltipProvider>
      <PlatformProvider platform={stubPlatform}>
        <ServiceProvider services={stubServices}>
          <StoreProvider broadcastService={noopBroadcastService}>
            <TabStoreProvider>
              {params.get("mode") === "panel" ? <PanelShell /> : <Shell />}
            </TabStoreProvider>
          </StoreProvider>
        </ServiceProvider>
      </PlatformProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
