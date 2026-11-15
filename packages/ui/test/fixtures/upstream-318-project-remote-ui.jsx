import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { ProjectManagement } from "../../src/project-sidebar/ProjectManagement.js";
import { SourceProfileList } from "../../src/remote-connection/SourceProfileList.js";
import {
  getRemoteServiceLifecycleDescription,
  getSourceServerDowngradeConfirmation,
  readSourceServerRunningTasksForConfirmation,
} from "../../src/lib/sourceServerUpdateAction.js";

// U4 定向浏览器夹具：挂真实 ProjectManagement / SourceProfileList，服务用内存适配器。
// 不读真实配置、不联网；Chromium 由 smoke 用临时 profile + loopback 页面启动。

const DAY = 86_400_000;
const NOW = Date.now();

function Providers({ children }) {
  return (
    <ZCodeIntlProvider initialLocale="en-US" resolveSystemLocale={() => "en-US"}>
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}

function project(id, overrides = {}) {
  return {
    id,
    hostId: "local",
    name: `Project ${id}`,
    nameOverridden: false,
    roots: [{ rootPath: `/work/${id}`, position: 0, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - 40 * DAY,
    ...overrides,
  };
}

function task(id, projectId, updatedAt, hostId = "local") {
  return {
    taskId: id,
    traceId: `trace-${id}`,
    title: `Task ${id}`,
    workspacePath: `/work/${projectId}`,
    workspaceIdentity: hostId === "local" ? undefined : `remote:${hostId}:/work/${projectId}`,
    createdAt: NOW - 120 * DAY,
    updatedAt,
    mode: "agent",
    projectId,
    hostId,
    pinned: false,
    archived: false,
  };
}

function createProjectService() {
  const projects = [
    project("alpha", { name: "Alpha" }),
    project("beta", { name: "Beta", primaryRootStatus: "missing" }),
    project("gamma", { name: "Gamma" }),
    project("remote", { hostId: "remote-1", name: "Remote", primaryRootStatus: "available" }),
  ];
  const tasks = [
    task("alpha-1", "alpha", NOW - 120 * DAY),
    task("remote-1", "remote", NOW - DAY, "remote-1"),
  ];
  const fixture = (window.projectFixture ??= {
    deleted: [],
    restored: [],
    measured: [],
    purged: [],
    failPurge: false,
  });
  const readTree = async () => ({
    projects: projects.map((item) => ({ ...item, roots: item.roots.map((root) => ({ ...root })) })),
    tasks: tasks.map((item) => ({ ...item })),
  });
  return {
    fixture,
    service: {
      readTree,
      readProjects: async () => projects.filter((item) => !item.deleted),
      deleteProject: async (id) => {
        fixture.deleted.push(id);
        const item = projects.find((candidate) => candidate.id === id);
        if (item) item.deleted = true;
      },
      restoreProject: async (id) => {
        fixture.restored.push(id);
        const item = projects.find((candidate) => candidate.id === id);
        if (item) item.deleted = false;
        return item;
      },
      measureProjectData: async (ids) => {
        fixture.measured.push([...ids]);
        return {
          projects: ids.map((id) => ({
            id,
            sessions: 1,
            sessionBytes: 2048,
            checkpointBytes: 1024,
            memoryBytes: 0,
          })),
        };
      },
      deleteProjectData: async (id) => {
        if (fixture.failPurge) {
          fixture.failPurge = false;
          throw new Error("fixture purge failure");
        }
        fixture.purged.push(id);
        return {
          freedBytes: 3072,
          deletedSessions: 1,
          runningSessions: 0,
          referencedSessions: 0,
          failed: 0,
        };
      },
      saveProject: async (input) => {
        if (input?.restoreProjectId) return { ...project(input.restoreProjectId), deleted: false };
        return project(input?.id ?? "created");
      },
      reorderProjects: async () => {},
      moveTask: async () => {},
      prepareSession: async () => ({
        workspacePath: "/work/alpha",
        additionalDirectories: [],
        projectId: "alpha",
      }),
      resolveSessionDirectories: async () => ({
        workspacePath: "/work/alpha",
        additionalDirectories: [],
        projectId: "alpha",
      }),
      readDirectory: async () => ({ path: "/work", entries: [] }),
    },
  };
}

function ProjectFixture() {
  const { service } = createProjectService();
  const services = useMemo(
    () => ({
      projectService: service,
      broadcastService: { onMessage: () => ({ dispose() {} }) },
      zcodeTaskService: {
        onDynamicWorkspaceEvent: () => () => ({ dispose() {} }),
      },
    }),
    [service],
  );
  return (
    <Providers>
      <ServiceProvider services={services}>
        <div className="mx-auto max-w-5xl p-6">
          <ProjectManagement workspacePath="/fixture" />
        </div>
      </ServiceProvider>
    </Providers>
  );
}

function createSourceFixture() {
  const rows = [
    {
      profileId: "p1",
      sourceServerId: "s1",
      displayName: "Online",
      transport: "ssh",
      targetLabel: "u@h:22",
      state: "online",
      lastSeenVersion: "3.17.0",
      currentVersion: "3.17.0",
      pendingIdentityChange: false,
    },
    {
      profileId: "p2",
      sourceServerId: "s2",
      displayName: "Old",
      transport: "ssh",
      targetLabel: "u@old:22",
      state: "online",
      lastSeenVersion: "3.16.0",
      currentVersion: "3.16.0",
      pendingIdentityChange: false,
    },
    {
      profileId: "p3",
      sourceServerId: "s3",
      displayName: "Updating",
      transport: "ssh",
      targetLabel: "u@update:22",
      state: "updating",
      lastSeenVersion: "3.17.0",
      updateCancelable: true,
      currentVersion: "3.17.0",
      pendingIdentityChange: false,
    },
    {
      profileId: "p4",
      sourceServerId: "s4",
      displayName: "Newer",
      transport: "ssh",
      targetLabel: "u@new:22",
      state: "online",
      lastSeenVersion: "3.17.0",
      currentVersion: "3.19.0",
      availableVersion: "3.18.2",
      updateAvailability: "required",
      upgradeTarget: "controller",
      pendingIdentityChange: false,
    },
  ];
  const fixture = (window.sourceFixture ??= { calls: [] });
  const management = {
    getSourceRunningTasks: async (sourceServerId) => {
      fixture.calls.push(["running-tasks", sourceServerId]);
      return {
        available: true,
        tasks: [{ sessionId: "task-1", workspacePath: "/work/one" }],
      };
    },
    stopSource: async (sourceServerId) => {
      fixture.calls.push(["stop", sourceServerId]);
      return {
        generation: 2,
        profiles: [],
        servers: [],
        workspaceHistory: [],
        states: [],
        failedPathCount: 0,
        abandonedPathCount: 0,
        migrationCounts: [],
      };
    },
    restartSource: async (sourceServerId) => {
      fixture.calls.push(["restart", sourceServerId]);
      return {
        generation: 2,
        profiles: [],
        servers: [],
        workspaceHistory: [],
        states: [],
        failedPathCount: 0,
        abandonedPathCount: 0,
        migrationCounts: [],
      };
    },
    cancelSourceUpdate: async (profileId) => {
      fixture.calls.push(["cancel", profileId]);
      return { canceled: true };
    },
    updateSource: async (input) => {
      fixture.calls.push(["update", input]);
      return {
        generation: 2,
        profiles: [],
        servers: [],
        workspaceHistory: [],
        states: [],
        failedPathCount: 0,
        abandonedPathCount: 0,
        migrationCounts: [],
      };
    },
  };
  return { rows, management, fixture };
}

function SourceFixture() {
  const { rows, management } = createSourceFixture();
  const [confirmation, setConfirmation] = useState(null);
  const format = (id, values) => (values ? `${id}:${JSON.stringify(values)}` : id);
  const ask = (copy, onConfirm) => setConfirmation({ ...copy, onConfirm });
  const lifecycle = async (row, action) => {
    const runningTasks = await readSourceServerRunningTasksForConfirmation(
      management,
      row.sourceServerId,
    );
    ask(
      {
        title: action,
        description: getRemoteServiceLifecycleDescription({
          action,
          runningTasks,
          startupAutoReconnect: false,
          formatMessage: (id) => id,
        }),
      },
      async () => {
        if (action === "restart") await management.restartSource(row.sourceServerId);
        else await management.stopSource(row.sourceServerId);
      },
    );
  };
  return (
    <Providers>
      <div className="mx-auto max-w-4xl p-6">
        <SourceProfileList
          rows={rows}
          onConnect={() => {}}
          onDisconnect={() => {}}
          onRemove={() => {}}
          onRestart={(row) => void lifecycle(row, "restart")}
          onStop={(row) => void lifecycle(row, "stop")}
          onCancelUpdate={(row) => void management.cancelSourceUpdate(row.profileId)}
          onDowngrade={(row) =>
            ask(
              getSourceServerDowngradeConfirmation(
                {
                  currentVersion: row.currentVersion,
                  availableVersion: row.availableVersion,
                },
                format,
              ),
              async () => {
                await management.updateSource({
                  profileId: row.profileId,
                  allowDowngrade: true,
                });
              },
            )
          }
        />
        {confirmation ? (
          <div data-testid="source-confirm" className="mt-4 rounded-xl border p-4">
            <p data-testid="source-confirm-title">{confirmation.title}</p>
            <p data-testid="source-confirm-description">{confirmation.description}</p>
            <button
              type="button"
              data-testid="source-confirm-cancel"
              onClick={() => setConfirmation(null)}
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="source-confirm-ok"
              onClick={() => {
                const next = confirmation.onConfirm;
                setConfirmation(null);
                void next();
              }}
            >
              confirm
            </button>
          </div>
        ) : null}
      </div>
    </Providers>
  );
}

const route = window.location.hash.slice(1);
createRoot(document.getElementById("root")).render(
  route === "source" ? <SourceFixture /> : <ProjectFixture />,
);
