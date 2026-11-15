import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ImagePreviewSurface } from "../../src/image-preview-editor/ImagePreviewSurface.js";
import { registerImageComposerTarget } from "../../src/image-preview-editor/composerTarget.js";
import { McpServerList } from "../../src/settings/McpServerList.js";
import { useConversationTimelineFind } from "../../src/v4/useConversationTimelineFind.js";
import {
  createPluginUiPagePlane,
  isSandboxDocumentNavigation,
} from "../../src/plugin-ui/adapters/pluginUiPagePlane.js";
import { createPluginUiPageRetention } from "../../src/plugin-ui/adapters/pluginUiPageRetention.js";
import { buildPluginUiHostCapabilities } from "../../src/plugin-ui/domain/buildPluginUiHostCapabilities.js";

// 上游 3.18 整合的定向浏览器夹具：只挂生产组件/模块，不复制行为判定。
// 不读真实配置、不联网；Chromium 由 smoke 脚本用临时 profile + loopback 页面启动。

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4EIwDiqkL4KAcT9GO0U4BxoAAAAAElFTkSuQmCC";

function Providers({ children }) {
  return (
    <ZCodeIntlProvider initialLocale="en-US" resolveSystemLocale={() => "en-US"}>
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}

function ImageEditorFixture() {
  const fixture = (window.imageFixture ??= {
    appended: [{ name: "existing-draft.png", type: "image/png", size: 99 }],
    saved: 0,
  });
  // 模拟已有草稿：append 进入同一个附件队列，已有附件必须保留。
  useMemo(
    () =>
      registerImageComposerTarget({
        append(file) {
          fixture.appended.push({ name: file.name, type: file.type, size: file.size });
          return true;
        },
      }),
    [],
  );
  return (
    <div className="fixed inset-0">
      <ImagePreviewSurface
        src={PNG}
        alt="fixture.png"
        filename="fixture.png"
        imageTestId="upstream-image-fixture"
        downloading={false}
        onDownload={async () => null}
        onSaved={() => {
          fixture.saved += 1;
        }}
        onClose={() => {}}
      />
    </div>
  );
}

const findRows = [
  { kind: "userInput", rowId: 1, text: "alpha find me", state: "complete" },
  {
    kind: "assistantText",
    rowId: 2,
    text: "beta find me twice find me",
    state: "complete",
  },
];
const findUnits = [
  {
    key: "turn-1",
    turnId: "turn-1",
    visibleUserInputs: [findRows[0]],
    assistantTextRows: [findRows[1]],
    latestAssistantTextRow: findRows[1],
    isRunning: false,
  },
];

function FindFixture() {
  const rootRef = useRef(null);
  const [query, setQuery] = useState("find me");
  const [activeIndex, setActiveIndex] = useState(0);
  const [navigationRequestId, setNavigationRequestId] = useState(0);
  const [state, setState] = useState({ matchCount: 0, activeIndex: -1 });
  const rows = useMemo(() => findRows, []);
  const units = useMemo(() => findUnits, []);
  useConversationTimelineFind({
    rootRef,
    renderUnits: units,
    rows,
    mountedRowsKey: "mount-1",
    canLoadOlder: false,
    loadingOlder: false,
    sessionPhase: "ready",
    conversationFindQuery: query,
    conversationFindActiveIndex: activeIndex,
    conversationFindNavigationRequestId: navigationRequestId,
    onConversationFindMatchStateChange: setState,
    scrollToUnit: () => {},
  });
  return (
    <div className="p-6">
      <input
        data-find-input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
      />
      <button
        type="button"
        data-find-next
        onClick={() => {
          setActiveIndex((value) => value + 1);
          setNavigationRequestId((value) => value + 1);
        }}
      >
        next
      </button>
      <div
        ref={rootRef}
        data-find-root
        data-find-match-count={state.matchCount}
        data-find-active-index={state.activeIndex}
        className="mt-4 h-40 overflow-auto"
      >
        {findRows.map((row) => (
          <div key={row.rowId} data-row-id={row.rowId} className="min-h-64 py-4">
            {row.text}
          </div>
        ))}
      </div>
    </div>
  );
}

const trustReview = {
  declarationDigest: "b".repeat(64),
  sourcePaths: ["/fixture/workspace/.zcodium/config.json"],
  display: "fixture-project",
  trusted: false,
  configuredEnabled: true,
  transport: "stdio",
};
const mcpServers = [
  {
    id: "fixture-project",
    name: "fixture-project",
    config: { command: "node", args: ["server.js"] },
    enabled: true,
    status: "unknown",
    source: "zcodeagentmcp",
    scope: "workspace",
    workspaceTrust: trustReview,
  },
];

function McpTrustFixture() {
  const fixture = (window.mcpTrustFixture ??= { trusts: [] });
  const [servers, setServers] = useState(mcpServers);
  return (
    <Providers>
      <div className="p-6">
        <McpServerList
          servers={servers}
          onCreate={() => {}}
          onEdit={() => {}}
          onToggle={() => {}}
          onTrustWorkspaceServer={(server) => {
            fixture.trusts.push({
              name: server.name,
              digest: server.workspaceTrust?.declarationDigest,
            });
            setServers((current) =>
              current.map((item) =>
                item.name === server.name
                  ? { ...item, workspaceTrust: { ...item.workspaceTrust, trusted: true } }
                  : item,
              ),
            );
          }}
          emptyTitle="empty"
          emptyDescription="empty"
        />
      </div>
    </Providers>
  );
}

function PluginExecutionFixture() {
  const fixture = (window.pluginExecutionFixture ??= {
    execution: [],
    retention: [],
    nestedFrames: {
      sandbox: isSandboxDocumentNavigation("zcode-sandbox://fixture/page"),
      aboutBlank: isSandboxDocumentNavigation("about:blank"),
      srcdoc: isSandboxDocumentNavigation(undefined),
      // 嵌套 frame 能力只经 hostCapabilities.experimental 声明，页面据此决定是否嵌入子 frame。
      capability:
        "zcode/nestedFrames" in
        buildPluginUiHostCapabilities({
          canSendFollowUpMessage: false,
          canUpdateModelContext: false,
          canSetWidgetState: false,
          canSubscribeResources: false,
          canDownloadFile: false,
        }).experimental,
    },
  });
  const containerRef = useRef(null);
  const planeRef = useRef(null);
  if (!planeRef.current) {
    planeRef.current = createPluginUiPagePlane({
      onVisibility: () => {},
      onCrash: () => {},
      onExecutionActive: (active) => fixture.execution.push(active),
    });
  }
  const anchorRef = useRef(null);
  useMemo(() => {
    planeRef.current.mount({
      instance: { token: "fixture" },
      sandboxId: "sb-fixture",
      initId: 1,
      shellUrl: "zcode-sandbox://fixture/page",
      partition: "persist:fixture",
      resourceMeta: { backgroundRetention: true },
    });
    return () => planeRef.current?.dispose();
  }, []);
  useMemo(() => {
    if (anchorRef.current) planeRef.current.bind({ kind: "flow", node: anchorRef.current });
  }, []);
  // retention.syncExecution 只依赖注入的判定回调（不触达全局 registry），验证“声明后台保留才执行”。
  useMemo(() => {
    const retention = createPluginUiPageRetention({
      page: () => ({ visible: false, suspend: async () => true }),
      handle: () => ({ resourceMeta: { backgroundRetention: true } }),
      hasController: () => true,
      phase: () => "running",
      ensure: () => {},
      hasVisibleAnchor: () => false,
      setExecutionActive: (active) => fixture.retention.push(active),
    });
    retention.syncExecution();
    const undeclared = createPluginUiPageRetention({
      page: () => ({ visible: false, suspend: async () => true }),
      handle: () => ({ resourceMeta: {} }),
      hasController: () => true,
      phase: () => "running",
      ensure: () => {},
      hasVisibleAnchor: () => false,
      setExecutionActive: (active) => fixture.retention.push(active),
    });
    undeclared.syncExecution();
  }, []);
  return (
    <div className="p-6">
      <div ref={anchorRef} data-plugin-anchor style={{ height: 96, width: 256 }} />
      <div ref={containerRef} style={{ height: 40 }} />
      <button
        type="button"
        data-execution-on
        onClick={() => planeRef.current.setExecutionActive(true)}
      >
        on
      </button>
      <button
        type="button"
        data-execution-off
        onClick={() => planeRef.current.setExecutionActive(false)}
      >
        off
      </button>
    </div>
  );
}

const section = window.location.hash.replace(/^#/u, "");
const Fixture =
  section === "image"
    ? ImageEditorFixture
    : section === "find"
      ? FindFixture
      : section === "mcp"
        ? McpTrustFixture
        : PluginExecutionFixture;

createRoot(document.getElementById("root")).render(
  <Providers>
    <Fixture />
  </Providers>,
);
