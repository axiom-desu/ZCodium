import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { StoreProvider } from "../../src/store/StoreProvider.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ConversationComposer } from "../../src/v4/ConversationComposer.js";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";

const noop = () => {};
const noopSub = Object.assign(() => noopSub, { dispose() {} });
const fixture = (window.composerPredictionFixture = {
  calls: [],
  cancels: [],
  resolve: null,
  sends: 0,
  mounts: 0,
  state: {
    mountId: 0,
    active: true,
    draft: {
      text: "[@fixture.ts](/fixture/workspace/fixture.ts)",
      mention: {
        id: "fixture-file",
        category: "files",
        label: "fixture.ts",
        value: "/fixture/workspace/fixture.ts",
        markdown: "[@fixture.ts](/fixture/workspace/fixture.ts)",
      },
    },
  },
  respond(
    result = {
      decision: "show",
      candidates: [{ text: "completion", confidence: 0.99 }],
      topConfidence: 0.99,
    },
  ) {
    fixture.resolve?.({ ...result, requestId: fixture.calls.at(-1)?.requestId });
  },
  remount(patch = {}) {
    fixture.setState((s) => ({ ...s, ...patch, mountId: s.mountId + 1 }));
  },
  setState: null,
  readText() {
    const input = document.querySelector(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    return input?.__zcodeLexicalInputE2E?.getText() ?? null;
  },
});
const zcodeAgentService = {
  async helloConversationV4() {
    return { capabilities: { inputPrediction: true } };
  },
  conversationInputPredictionV4(request) {
    fixture.calls.push(request);
    return new Promise((resolve) => {
      fixture.resolve = resolve;
    });
  },
  async cancelConversationInputPredictionV4(request) {
    fixture.cancels.push(request);
  },
};
const services = new Proxy(
  { broadcastService: { onMessage: noopSub, async send() {} }, zcodeAgentService },
  {
    get: (target, key) =>
      key in target
        ? target[key]
        : new Proxy(() => Promise.resolve(undefined), {
            get: (_fn, prop) => (prop === "then" ? undefined : noopSub),
          }),
  },
);
const platform = new Proxy(
  {
    getDesktopZoomLevel: async () => ({ zoomLevel: 0 }),
    getUpdateState: async () => ({ kind: "idle" }),
  },
  {
    get: (target, key) =>
      key in target
        ? target[key]
        : String(key).startsWith("on")
          ? () => noop
          : async () => undefined,
  },
);
const onSendText = async () => {
  fixture.sends += 1;
  return "sent";
};
const attachmentPut = async () => ({ attachmentId: "fixture" });

function Mount({ state }) {
  const composerDraft = useMemo(() => ({ updatedAt: 1, ...state.draft }), [state.draft]);
  const snapshot = {
    revision: state.mountId,
    control: { canStop: !state.active, phase: "idle" },
    inputRouting: { mode: "startNow" },
    queue: { items: [] },
    rows: { totalCount: 2 },
    config: {},
    usage: null,
    backgroundWorks: [],
  };
  return (
    <ConversationComposer
      snapshot={snapshot}
      sessionId="prediction-fixture-session"
      composerDraft={composerDraft}
      updateComposerContent={noop}
      replaceComposerDraft={noop}
      attachmentPut={attachmentPut}
      autoFocusEnabled={false}
      workspacePath="/fixture/input-prediction"
      onSendText={onSendText}
      onStop={noop}
      onSelectModel={noop}
      onSelectThought={noop}
      onSwitchMode={noop}
      listenAddToChatEvents={false}
    />
  );
}
function Harness() {
  const [state, setState] = useState(fixture.state);
  fixture.state = state;
  fixture.setState = setState;
  fixture.mounts = state.mountId + 1;
  const stableSet = useCallback((patch) => setState((s) => ({ ...s, ...patch })), []);
  fixture.remount = (patch = {}) => stableSet({ ...patch, mountId: state.mountId + 1 });
  return (
    <div data-testid="composer-prediction-harness">
      <Mount key={state.mountId} state={state} />
    </div>
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
