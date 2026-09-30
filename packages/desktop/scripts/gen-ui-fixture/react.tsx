import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { GenUiMessageResponse } from "../../../ui/src/gen-ui/components/GenUiMessageResponse.js";
import { ServiceProvider } from "../../../ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../ui/src/hooks/usePlatform.js";
import { TabStoreProvider } from "../../../ui/src/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "../../../ui/src/i18n/IntlProvider.js";
import { useRemoteWorkspaceSessionStore } from "../../../ui/src/store/remoteWorkspaceSessionStore.js";
import { registerPluginUiSessionActions } from "../../../ui/src/plugin-ui/hostPrimitives.js";
import type { IServiceAccessor } from "@zcode/services";
import type { GenUiStateChange } from "@zcode/shared/gen-ui";
import type { PluginSandboxPortsEvent } from "@zcode/shared/mcp-apps";
const harness = (window as any).harness;
const ports = new Set<(event: PluginSandboxPortsEvent) => void>();
const states = new Set<(event: GenUiStateChange) => void>();
let reads = 0,
  preparations = 0;
const messages: unknown[] = [];
const taskListeners = new Set<(event: unknown) => void>();
let activeSession = "fixture";
const deadlines = new Set<() => void>();
const nativeSetTimeout = window.setTimeout.bind(window);
window.setTimeout = ((run: () => void, ms?: number, ...args: unknown[]) => {
  if (ms === 300000) deadlines.add(run);
  return nativeSetTimeout(run, ms, ...args);
}) as typeof window.setTimeout;
window.addEventListener("message", (event) => {
  if (event.data?.type === "zcode:plugin-sandbox-ports")
    for (const handler of ports) handler({ ...event.data, port: event.ports[0] });
  if (event.data?.type === "fixture-notification")
    for (const handler of states) handler(event.data.payload);
});
void (async () => {
  const config = await harness.config();
  const target = {
    workspacePath: config.root,
    workspaceIdentity: "ssh:fixture:/workspace",
    remoteSessionId: "remote-1",
    sessionId: "fixture",
    path: config.path,
    instanceKey: "react:0",
  };
  const service = new Proxy(
    {},
    {
      get: (_, method) => {
        if (method === "onStateChanged")
          return (handler: (event: GenUiStateChange) => void) => {
            states.add(handler);
            return { dispose: () => states.delete(handler) };
          };
        return (input: unknown) => {
          if (method === "readDocument")
            throw new Error("Remote file incorrectly read from desktop");
          if (method === "prepareSandbox") preparations++;
          return harness.bridge(method, input);
        };
      },
    },
  );
  const base = {
    genUiService: service,
    zcodeTaskService: {
      onDynamicWorkspaceEvent: () => (listener: (event: unknown) => void) => {
        taskListeners.add(listener);
        return { dispose: () => taskListeners.delete(listener) };
      },
    },
  } as unknown as IServiceAccessor;
  const remote = {
    genUiService: {
      readDocument(input: unknown) {
        reads++;
        return harness.bridge("readDocument", input);
      },
    },
  } as unknown as IServiceAccessor;
  useRemoteWorkspaceSessionStore.setState({
    baseServices: base,
    sessionsById: { "remote-1": { sessionId: "remote-1", services: remote } },
    sessionIdByWorkspaceIdentity: { [target.workspaceIdentity]: "remote-1" },
  });
  const unregister = registerPluginUiSessionActions(target, {
    async sendFollowUp(message) {
      messages.push(message);
    },
  });
  const platform = {
    pluginSandbox: {
      supportsRetainedMove: window.zcodePluginSandbox?.supportsRetainedMove,
      copyImage: (request) => window.zcodePluginSandbox!.copyImage!(request),
      getOwnerWebContentsId: () => harness.owner(),
      disposeSandbox: (id: string, init: number) => harness.dispose(id, init),
      consumeUserGesture: () => harness.gesture(),
      onPorts(handler: (event: PluginSandboxPortsEvent) => void) {
        ports.add(handler);
        return () => {
          ports.delete(handler);
        };
      },
    },
  };
  const reactRoot = createRoot(document.getElementById("root")!);
  // 回归真实模型输出：从正文解析进入卡片，直接挂 GenUiCard 无法发现 directive 未识别。
  let mode: "normal" | "wide" = "wide";
  const renderReply = (phase: "streaming" | "complete" | "hidden") =>
    reactRoot.render(
      <ZCodeIntlProvider initialLocale="en-US">
        <TabStoreProvider>
          <ServiceProvider services={remote}>
            <PlatformProvider platform={platform as never}>
              <div id="gen-ui-scroll" style={{ height: 650, overflow: "auto" }}>
                <div className="w-full" style={{ padding: 5 }} data-conversation-selectable="true">
                  {phase !== "hidden" && (
                    <GenUiMessageResponse
                      completed={phase === "complete"}
                      streaming={phase === "streaming"}
                      messageKey="react"
                      workspacePath={target.workspacePath}
                      workspaceIdentity={target.workspaceIdentity}
                      workspaceRemoteSessionId={target.remoteSessionId}
                      sessionId={activeSession}
                    >
                      {`Before view\n\n::visualize${JSON.stringify({ path: config.paths[activeSession], title: "Gen UI test", ...(mode === "wide" ? { mode } : {}) })}\n\nAfter view`}
                    </GenUiMessageResponse>
                  )}
                  <div style={{ height: 1000 }} />
                </div>
              </div>
            </PlatformProvider>
          </ServiceProvider>
        </TabStoreProvider>
      </ZCodeIntlProvider>,
    );
  flushSync(() => renderReply("streaming"));
  Object.assign(window, {
    setInlineMode: (value: "normal" | "wide") => {
      mode = value;
      flushSync(() => renderReply("complete"));
    },
    showReply: (phase: "streaming" | "complete" | "hidden") => flushSync(() => renderReply(phase)),
    disableSession: unregister,
    showTask: (session: string) => {
      activeSession = session;
      flushSync(() => renderReply("complete"));
    },
    expireOffscreen: () => {
      for (const run of deadlines) run();
      deadlines.clear();
    },
    deleteTask: (session: string) => {
      for (const listener of taskListeners)
        listener({ type: "workspace_task_list_changed", reason: "task_deleted", taskId: session });
    },
    inspectReact: () => ({
      reads,
      preparations,
      messages,
      ports: ports.size,
      states: states.size,
      tasks: taskListeners.size,
    }),
  });
})();
