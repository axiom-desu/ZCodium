import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { applyTheme } from "../../src/useTheme.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { ResizablePanel, ResizablePanelGroup } from "../../src/components/ui/resizable.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { AnimatedSidePanePanel } from "../../src/app-shell/AnimatedSidePanePanel.js";
import { useAnimatedResizablePanel } from "../../src/app-shell/useAnimatedResizablePanel.js";
import { useWorkbenchPaneCount } from "../../src/app-shell/useWorkbenchPaneCount.js";
import {
  SidePaneFullViewConversationHost,
  readFloatingAnchorPreference,
  useConversationPanePresentation,
  useSidePaneFullView,
  writeFloatingAnchorPreference,
} from "../../src/side-pane-full-view/index.js";
import { useAppKeyboard } from "../../src/hooks/useAppKeyboard.js";
import { ChatPromptEditor } from "../../src/prompt-editor/ChatPromptEditor.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import { usePaneLayoutStore } from "../../src/v4/paneLayoutStore.js";

// Side Pane 完整视图的隔离浏览器夹具（spec：docs/specs/side-pane-full-view.md）。
// 它不复制被测逻辑：完整视图宿主/状态 owner/内存/面板/快捷键分发/输入框都是生产组件；
// 夹具只提供 workspace shell 的布局外壳与一个可断言的对话内容桩（草稿/滚动/上传）。
const params = new URLSearchParams(location.search);
const workspacePath = "/fixture/workspace";
const isDesktop = params.get("platform") !== "web";
const fixture = (window.fullViewFixture = {
  mounts: 0,
  uploads: [],
  draft: "",
  owner: "task-a",
  paneOpen: params.get("pane") !== "closed",
  setOwner: () => {},
  togglePane: () => {},
  splitPane: () => {},
  resetPanes: () => {},
});
applyTheme(params.get("theme") || "light");

// 夹具只补产输入框初始化会调用的只读服务；其余访问保持 undefined（不触发真实 IO）。
const stubServiceValues = {
  subagentsService: { list: async () => ({ agents: [], capability: null }) },
};
const stubServices = new Proxy(stubServiceValues, {
  get: (target, key) => (key in target ? target[key] : undefined),
});
const stubPlatform = new Proxy(
  { onSettingsChanged: () => () => {} },
  {
    get: (target, key) =>
      key in target ? target[key] : String(key).startsWith("on") ? () => () => {} : () => undefined,
  },
);

const ROWS = Array.from({ length: 200 }, (_, index) => `row-${index}`);

/** 对话内容桩：一份挂载的滚动区 + 生产 ChatPromptEditor，用来断言“没有重新挂载”。 */
function ConversationPane({ draft, onDraftChange, uploads, onAttach }) {
  const scrollRef = useRef(null);
  const presentation = useConversationPanePresentation();
  const floating = presentation.presentation === "floating";
  useEffect(() => {
    fixture.mounts += 1;
  }, []);
  useEffect(() => {
    fixture.scrollRef = scrollRef.current;
  }, []);
  useEffect(() => {
    // 只把宿主公开的上报接口暴露给 E2E；运行状态/阻塞交互本身仍由生产宿主推进。
    fixture.reportStatus = presentation.reportFloatingStatus;
    fixture.reportDockHeight = presentation.reportComposerDockHeight;
  }, [presentation.reportFloatingStatus, presentation.reportComposerDockHeight]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        ref={scrollRef}
        data-testid="fixture-scroll"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2"
      >
        {ROWS.map((row) => (
          <p key={row} className="text-ui-base text-foreground-subtle">
            {row}
          </p>
        ))}
      </div>
      <div data-v4-composer-dock="true" className="shrink-0 border-t border-border p-2">
        {uploads.length > 0 ? (
          <ul data-testid="fixture-uploads" className="mb-1 flex flex-col gap-1">
            {uploads.map((upload) => (
              <li key={upload} className="text-ui-sm text-foreground-subtle">
                {upload}
              </li>
            ))}
          </ul>
        ) : null}
        <ChatPromptEditor
          workspacePath={workspacePath}
          taskId={null}
          initialValue={draft}
          inputTestId="v4-composer-input"
          layout={floating ? "inline" : "stacked"}
          placeholder={fixture.placeholder || "fixture composer"}
          enableMentionPanel={false}
          onChange={(value) =>
            onDraftChange(typeof value === "string" ? value : (value?.markdown ?? ""))
          }
          onSubmit={() => {}}
        />
        <button
          type="button"
          data-testid="fixture-attach"
          className="mt-1 rounded-lg border border-border px-2 py-1 text-ui-sm text-foreground"
          onClick={onAttach}
        >
          attach
        </button>
      </div>
    </div>
  );
}

const sidePaneState = {
  tabs: [
    {
      id: "board",
      type: "whiteboard",
      boardId: "fixture-board",
      ownerTaskId: "task-a",
      workspaceKey: workspacePath,
      openedAt: 1,
    },
  ],
  activeTabId: "board",
};

const noop = () => {};

function Shell() {
  const [isSidePaneOpen, setIsSidePaneOpen] = useState(fixture.paneOpen);
  const [ownerId, setOwnerId] = useState(fixture.owner);
  const [draft, setDraft] = useState(fixture.draft);
  const [uploads, setUploads] = useState(fixture.uploads);
  const [slotElement, setSlotElement] = useState(null);
  const [anchor, setAnchor] = useState(readFloatingAnchorPreference);

  // 夹具镜面值直接来自渲染期 state：E2E 读到的 paneOpen 与 React 事实永远一致。
  fixture.paneOpen = isSidePaneOpen;
  fixture.owner = ownerId;
  const paneCount = useWorkbenchPaneCount();
  const supported = isDesktop && paneCount <= 1;
  const fullView = useSidePaneFullView({
    workspacePath,
    ownerId,
    isSidePaneOpen,
    enabled: supported,
  });
  const activeFullView = fullView.fullView;
  const isFullView = activeFullView !== null;
  const mode = !activeFullView
    ? "normal"
    : activeFullView.surface === "conversation"
      ? "conversation"
      : "floating";

  const {
    panelRef: sidePanePanelRef,
    panelElementRef,
    isVisible,
  } = useAnimatedResizablePanel({
    open: isSidePaneOpen,
    expandedSize: "42%",
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
  });

  const handleToggleFullView = useCallback(() => {
    if (!fullView.fullView && !isSidePaneOpen) {
      fullView.enter();
      setIsSidePaneOpen(true);
      return;
    }
    fullView.toggle();
  }, [fullView, isSidePaneOpen]);
  // 真实全局键盘分发：桌面端注册处理器，Web 端为 null（不消费按键）。
  useAppKeyboard({
    toggleSidePaneFullView: supported ? handleToggleFullView : null,
  });

  const handleAttach = useCallback(() => {
    setUploads((current) => {
      const next = [...current, `upload-${current.length + 1}`];
      fixture.uploads = next;
      return next;
    });
  }, []);
  const handleDraftChange = useCallback((value) => {
    fixture.draft = value;
    setDraft(value);
  }, []);

  // 夹具暴露给 E2E 的 shell 操作：切 owner、开关面板、模拟多 pane。
  useEffect(() => {
    fixture.setOwner = (nextOwner) => {
      setOwnerId(nextOwner);
    };
    fixture.togglePane = () => {
      setIsSidePaneOpen((current) => !current);
    };
    fixture.splitPane = () => {
      usePaneLayoutStore.getState().splitPane("workspace-main", "right", { workspacePath });
    };
    fixture.resetPanes = () => {
      usePaneLayoutStore.getState().resetToPrimaryPane();
    };
  }, []);

  const conversation = (
    <ConversationPane
      draft={draft}
      onDraftChange={handleDraftChange}
      uploads={uploads}
      onAttach={handleAttach}
    />
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background-alt">
      <aside className="w-[240px] shrink-0 border-r border-border bg-sidebar p-2">
        <p className="text-ui-base text-foreground">fixture sidebar</p>
        <p data-testid="fixture-owner" className="text-ui-sm text-foreground-subtle">
          {ownerId}
        </p>
        <p data-testid="fixture-pane-count" className="text-ui-sm text-foreground-subtle">
          {paneCount}
        </p>
      </aside>
      <div id="content" className="flex min-w-0 flex-1 flex-col p-1">
        <ResizablePanelGroup
          layoutId="fixture-body"
          panelIds={["conversation-column", "browser"]}
          className={isFullView ? "relative min-h-0 flex-1" : "min-h-0 flex-1"}
        >
          <ResizablePanel
            id="conversation-column"
            minSize="35%"
            defaultSize={isSidePaneOpen ? "58%" : undefined}
          >
            <section
              data-testid="fixture-conversation-frame"
              className={
                isFullView
                  ? "relative flex h-full min-h-0 flex-col overflow-hidden rounded-none border-0 bg-background"
                  : "relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background"
              }
            >
              {!isFullView ? (
                <header
                  data-testid="fixture-workspace-header"
                  className="flex h-12 shrink-0 items-center border-b border-border/50 px-2 text-ui-base text-foreground"
                >
                  workspace header
                </header>
              ) : null}
              <div className="min-h-0 flex-1 overflow-hidden">
                <SidePaneFullViewConversationHost
                  mode={mode}
                  floating={activeFullView?.floating ?? "collapsed"}
                  anchor={anchor}
                  slotElement={slotElement}
                  onFloatingChange={fullView.setFloating}
                  onAnchorChange={(next) => {
                    setAnchor(next);
                    writeFloatingAnchorPreference(next);
                  }}
                  onOpenConversation={() => fullView.setSurface("conversation")}
                >
                  {conversation}
                </SidePaneFullViewConversationHost>
              </div>
            </section>
          </ResizablePanel>
          <AnimatedSidePanePanel
            services={stubServices}
            isDesktop={isDesktop}
            isWindowsDesktop={false}
            isVisible={isVisible}
            sidePaneState={sidePaneState}
            recentClosedSidePaneTabs={[]}
            isBrowserOpen={false}
            supportsEmbeddedBrowser={false}
            workspaceAbsPath={workspacePath}
            activeTaskId={ownerId === "__draft__" ? null : ownerId}
            sidePaneOwnerId={ownerId}
            gitState={{ summary: null, loading: false, error: null }}
            activeGitSourceId="unstaged"
            panelRef={sidePanePanelRef}
            panelElementRef={panelElementRef}
            browserNavigationRequest={null}
            browserRestoreUrls={{}}
            fileChangeFindActiveIndex={0}
            fileChangeFindNavigationRequestId={0}
            fileChangeFindQuery=""
            onFileChangeFindMatchCountChange={noop}
            onCloseCodeViewer={noop}
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
            onCloseSidePane={() => setIsSidePaneOpen(false)}
            toggleSidePaneShortcutLabel="⌥⌘B"
            fullViewToggle={
              isDesktop
                ? {
                    active: isFullView,
                    onToggle: fullView.toggle,
                    ...(paneCount > 1
                      ? { disabledReason: "Unavailable while the conversation is split" }
                      : {}),
                  }
                : undefined
            }
            fullView={
              activeFullView
                ? {
                    surface: activeFullView.surface,
                    conversationTitle: ownerId === "__draft__" ? "New Task" : ownerId,
                    onSelectSurface: fullView.setSurface,
                  }
                : null
            }
            fullViewSlotRef={setSlotElement}
          />
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") || "en-US"}>
    <TooltipProvider>
      <PlatformProvider platform={stubPlatform}>
        <ServiceProvider services={stubServices}>
          {/* 生产 ChatPromptEditor 经 LexicalChatInput 读 tab store（当前任务 provider）。 */}
          <TabStoreProvider>
            <Shell />
          </TabStoreProvider>
        </ServiceProvider>
      </PlatformProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
