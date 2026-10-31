import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectEditorDialog } from "../../src/project-sidebar/ProjectEditorDialog.js";
import { ProjectMoveTaskDialog } from "../../src/project-sidebar/ProjectMoveTaskDialog.js";
import { ProjectRestoreDialog } from "../../src/project-sidebar/ProjectRestoreDialog.js";
import { useProjectSidebarData } from "../../src/project-sidebar/useProjectSidebarData.js";
import { useProjectSidebarCommands } from "../../src/project-sidebar/useProjectSidebarCommands.js";
import { WorkspaceSidebar } from "../../src/WorkspaceSidebar.js";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { StoreProvider } from "../../src/store/StoreProvider.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") ?? "local";
const workspacePath = params.get("workspace") ?? "/fixture/workspace";
const directories = [];
const fixture = (window.projectSidebarFixture = {
  selected: [],
  created: [],
  drafts: [],
  directories,
  errors: [],
  events: [],
  reads: [],
});

function noopEvent() {
  const listeners = new Set();
  const event = (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  event.fire = (value) => {
    for (const listener of listeners) listener(value);
  };
  return event;
}

const broadcastEvent = noopEvent();
const workspaceEvents = new Map();
const noopSub = Object.assign(() => noopSub, { dispose() {} });

function workspaceKey(scope) {
  return JSON.stringify([(scope.workspaceIdentity ?? "").trim() || scope.workspacePath]);
}

const eventSource = new EventSource("/api/events");
eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data);
  fixture.events.push(message);
  if (message.kind === "broadcast") {
    broadcastEvent.fire({ channel: message.channel, payload: message.payload });
    return;
  }
  if (message.kind === "workspace") {
    const event = workspaceEvents.get(workspaceKey(message.scope));
    event?.fire(message.event);
  }
};
eventSource.onerror = () => {
  fixture.errors.push("events-disconnected");
};

function firstDirectory() {
  const next = fixture.directories.shift();
  return next ?? null;
}

let barrier;
fixture.arm = (method, fail = false) => {
  let release;
  barrier = {
    method,
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
async function projectCall(method, args = []) {
  const held = barrier?.method === method && !barrier.started ? barrier : null;
  if (held) held.started = true;
  const response = await fetch("/api/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, method, args }),
  });
  const text = await response.text();
  if (held) {
    await held.promise;
    held.done = true;
    if (held.fail) throw new Error("stale-fixture-error");
  }
  if (!response.ok) throw new Error(text || `project.${method} failed`);
  return text ? JSON.parse(text) : undefined;
}

async function taskCall(op, input) {
  const response = await fetch("/api/task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, input }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `task.${op} failed`);
  return text ? JSON.parse(text) : undefined;
}

const projectService = {
  readDirectory: (input) => projectCall("readDirectory", [input ?? {}]),
  readProjects: (input) => projectCall("readProjects", [input ?? {}]),
  readTree: (input) => {
    fixture.reads.push(0);
    return projectCall("readTree", [input ?? {}]);
  },
  saveProject: (input) => projectCall("saveProject", [input]),
  deleteProject: (id, hostId) => projectCall("deleteProject", [id, hostId]),
  moveTask: (input) => projectCall("moveTask", [input]),
  reorderProjects: (ids, hostId) => projectCall("reorderProjects", [ids, hostId]),
  moveTaskGroupNode: (input, hostId) => projectCall("moveTaskGroupNode", [input, hostId]),
  prepareSession: (input) => projectCall("prepareSession", [input ?? {}]),
  resolveSessionDirectories: (task, hostId) =>
    projectCall("resolveSessionDirectories", [task, hostId]),
};

const zcodeTaskService = {
  onDynamicWorkspaceEvent: (scope) => (listener) => {
    const key = workspaceKey(scope);
    const event = workspaceEvents.get(key) ?? noopEvent();
    workspaceEvents.set(key, event);
    return event(listener);
  },
  renameTask: (input) => taskCall("rename", input),
  setTaskPinned: (input) => taskCall("pin", input),
  archiveTask: (input) => taskCall("archive", input),
  unarchiveTask: (input) => taskCall("unarchive", input),
  deleteTask: (input) => taskCall("delete", input),
  setTaskUnread: (input) => taskCall("unread", input),
  createTaskGroup: async () => ({ id: "fixture-group", title: "New Group", color: "gray" }),
  renameTaskGroup: async (input) => ({ id: input.groupId, title: input.title, color: "gray" }),
  updateTaskGroupColor: async (input) => ({
    id: input.groupId,
    title: "Group",
    color: input.color,
  }),
  deleteTaskGroup: async () => {},
};

const broadcastService = {
  onMessage: broadcastEvent,
  send: async () => {},
  acquireClaim: async () => ({ status: "acquired", lease: { token: "fixture" } }),
  commitClaim: async () => {},
  releaseClaim: async () => {},
  tryClaim: async () => true,
};

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
      return Promise.resolve(undefined);
    },
  });
}

const pending = () => new Promise(() => {});
const zcodeAgentService = makeService("zcodeAgentService");
for (const key of [
  "helloConversationV4",
  "initializeConversationV4",
  "subscribeSessionsIndexV4",
  "resyncSessionsIndexV4",
  "unsubscribeSessionsIndexV4",
]) {
  zcodeAgentService[key] = pending;
}

const settings = {
  recentProjects: [],
  lastWorkspaceSession: [{ kind: "local", workspacePath }],
  lastActiveTabIndex: 0,
};
const settingService = {
  async get() {
    return structuredClone(settings);
  },
  async update(patch) {
    Object.assign(settings, patch);
  },
  onDidChange: noopSub,
};

const platform = makeService("platform");
platform.selectDirectory = async () => firstDirectory();
platform.getWebRemoteControlStatus = async () => ({ status: "idle" });
platform.onWebRemoteControlStatusChanged = () => () => {};
platform.runDesktopCommand = async () => ({ success: true });
platform.connectRemote = async () => ({ success: true });

const services = {
  projectService,
  zcodeTaskService,
  broadcastService,
  zcodeAgentService,
  settingService,
  zcodeSessionService: makeService("zcodeSessionService"),
  fileService: makeService("fileService"),
  gitService: makeService("gitService"),
  terminalService: makeService("terminalService"),
  systemService: makeService("systemService"),
  credentialService: makeService("credentialService"),
  conversationShareService: makeService("conversationShareService"),
  botsService: makeService("botsService"),
  fileWatcherService: makeService("fileWatcherService"),
  providerSettingsService: makeService("providerSettingsService"),
  modelSelectionService: makeService("modelSelectionService"),
  usageStatsService: makeService("usageStatsService"),
  codingPlanSubscriptionService: makeService("codingPlanSubscriptionService"),
  clientConfigService: makeService("clientConfigService"),
  clientScenesService: makeService("clientScenesService"),
  skillsService: makeService("skillsService"),
  skillSyncService: makeService("skillSyncService"),
  mcpSyncService: makeService("mcpSyncService"),
  pluginSyncService: makeService("pluginSyncService"),
  pluginsService: makeService("pluginsService"),
  pluginManagementService: makeService("pluginManagementService"),
  subagentsService: makeService("subagentsService"),
  commandsService: makeService("commandsService"),
  hooksService: makeService("hooksService"),
  memoryService: makeService("memoryService"),
  settingsSyncService: makeService("settingsSyncService"),
  promptAttachmentTransferService: makeService("promptAttachmentTransferService"),
  gitCheckpointService: makeService("gitCheckpointService"),
  onboardingRecordService: makeService("onboardingRecordService"),
  windowControllerService: makeService("windowControllerService"),
};

function DialogHarness({ scope }) {
  const data = useProjectSidebarData({ workspacePath: scope });
  fixture.refresh = data.refresh;
  const commands = useProjectSidebarCommands(data.refresh);
  const [open, setOpen] = useState(true);
  fixture.setDialogOpen = setOpen;
  const projectRef = useRef(null);
  if (!projectRef.current)
    projectRef.current = data.tree?.projects.find(
      (entry) => !entry.deleted && (!params.get("project") || entry.name === params.get("project")),
    );
  const project = projectRef.current;
  const onClose = () => {
    fixture.events.push("dialog-closed");
    setOpen(false);
  };
  const common = { open, commands, scope: data, onClose };
  const kind = params.get("dialog");
  if (!project || !data.tree) return null;
  return (
    <>
      <output data-testid="dialog-harness-ready">{scope}</output>
      <button data-testid="harness-close" onClick={() => setOpen(false)}>
        Close
      </button>
      {kind === "editor" || kind === "delete" ? (
        <ProjectEditorDialog
          {...common}
          project={kind === "delete" ? project : undefined}
          initialDeletePending={kind === "delete"}
          onSaved={() => fixture.events.push("saved")}
        />
      ) : kind === "move" ? (
        <ProjectMoveTaskDialog
          {...common}
          project={project}
          projects={data.tree.projects}
          tasks={data.tree.tasks}
        />
      ) : (
        <ProjectRestoreDialog
          {...common}
          projects={data.tree.projects.filter((entry) => entry.deleted)}
          onRestored={() => fixture.events.push("restored")}
        />
      )}
    </>
  );
}

function Fixture() {
  const [scope, setScope] = useState(workspacePath);
  const [serviceVersion, setServiceVersion] = useState(0);
  fixture.setScope = setScope;
  fixture.swapService = () => setServiceVersion((value) => value + 1);
  const scopedServices = useMemo(
    () =>
      serviceVersion
        ? {
            ...services,
            projectService: {
              ...projectService,
              readTree: (input) => {
                fixture.reads.push(serviceVersion);
                return projectCall("readTree", [input ?? {}]);
              },
            },
          }
        : services,
    [serviceVersion],
  );
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <PlatformProvider platform={platform}>
        <ServiceProvider services={scopedServices}>
          <StoreProvider broadcastService={broadcastService}>
            <TabStoreProvider>
              <TooltipProvider>
                <div style={{ height: "100vh", width: 320 }}>
                  {params.has("dialog") ? (
                    <DialogHarness scope={scope} />
                  ) : (
                    <WorkspaceSidebar
                      workspacePath={scope}
                      activePreviewPath={null}
                      onSelectTask={(path, taskId, identity, remoteSessionId, unreadAt) => {
                        fixture.selected.push({
                          path,
                          taskId,
                          identity,
                          remoteSessionId,
                          unreadAt,
                        });
                      }}
                      onStartDraftInWorkspace={(path, identity) => {
                        fixture.drafts.push({ path, identity });
                      }}
                      onCreateTask={(request) => {
                        fixture.created.push(request ?? null);
                      }}
                      onCreateConversationTask={() => {}}
                      onOpenFolderFromWorkspaceMenu={() => {}}
                      theme="light"
                      onConnectRemote={async () => "connected"}
                      onSelectRemoteProject={async () => {}}
                      onCancelRemoteProject={async () => {}}
                      onReconnectRemoteWorkspace={async () => {}}
                      reconnectingRemoteWorkspaceKeys={[]}
                      remoteWorkspaceErrorByWorkspaceKey={{}}
                      onOpenCommandCenter={() => {}}
                      onFileTreeOpenChange={() => {}}
                    />
                  )}
                </div>
              </TooltipProvider>
            </TabStoreProvider>
          </StoreProvider>
        </ServiceProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
