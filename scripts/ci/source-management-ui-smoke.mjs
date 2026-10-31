/* eslint-disable max-lines -- fixture 与真实浏览器场景集中在一个可复跑的验收脚本里，拆分会重复平台/假 backend 装配。 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

/**
 * Source 管理向导的真实浏览器验收。
 *
 * 入口是真实 `packages/ui` 的 SSHDialog / SourceProfileList / approval panel /
 * useSourceServerManagementSnapshot / credential port，只把 Host 管理服务和平台连接
 * 替换成假 backend。全程 loopback，不连接任何真实 SSH/WSL/Docker 或用户 server。
 */

const root = resolve(import.meta.dirname, "../..");
// 复用 packages/services 已声明的 esbuild，不把构建工具提升成新的根依赖。
const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
// fixture 内联在脚本里：浏览器用例依赖真实 React 源码入口，不额外落一个只被 URL 引用的仓库文件。
const fixtureDir = await mkdtemp(resolve(root, "node_modules/.cache/source-ui-"));
await mkdir(fixtureDir, { recursive: true });
const fixtureSource = String.raw`
import { createRoot } from "react-dom/client";
import { useMemo } from "react";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SSHDialog } from "@/SSHDialog.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import {
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteWorkspaceSessionMutation,
} from "@/lib/remoteWorkspaceHistory.js";

const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "install";
const events = [];
window.__sourceEvents = events;
window.__settleConfirm = (confirmed) =>
  useConfirmDialogStore.getState().settleConfirmation(confirmed);
window.__hasPendingConfirm = () => Boolean(useConfirmDialogStore.getState().pendingRequest);

const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const sshTarget = { kind: "ssh", host: "host.example", port: 22, username: "dev" };

function baseSnapshot(overrides = {}) {
  return {
    generation: 1,
    profiles: [],
    servers: [],
    workspaceHistory: [],
    states: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
    ...overrides,
  };
}

function profileSnapshot(state = "offline") {
  const profile = {
    profileId: PROFILE_ID,
    transport: "ssh",
    target: { ...sshTarget, passwordCredentialKey: "source-server:profile:password" },
    displayName: "Build box",
    createdAt: 1,
    lifecycleState: "active",
    ...(state === "online" ? { sourceServerId: SOURCE_ID } : {}),
  };
  return baseSnapshot({
    generation: 2,
    profiles: [profile],
    states: [
      {
        profileId: PROFILE_ID,
        ...(state === "online" ? { sourceServerId: SOURCE_ID } : {}),
        state,
        updatedAt: 1,
      },
    ],
    ...(state === "online"
      ? {
          servers: [
            {
              sourceServerId: SOURCE_ID,
              displayName: "Build box",
              installState: "installed",
              declaredWorkspaces: [],
              preferredProfileId: PROFILE_ID,
            },
          ],
        }
      : {}),
  });
}

let snapshot = scenario === "force" || scenario === "profile" ? profileSnapshot() : baseSnapshot();

function codeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function onlineSnapshot() {
  return profileSnapshot("online");
}

function installSnapshot() {
  return {
    ...profileSnapshot("needs-install"),
    generation: 4,
    states: [
      {
        profileId: PROFILE_ID,
        state: "needs-install",
        installPreview: {
          version: "3.16.2",
          sizeBytes: 4096,
          installPath: "/home/dev/.zcode/server",
        },
        availableVersion: "3.16.2",
        updatedAt: 1,
      },
    ],
  };
}

function runningSnapshot() {
  return {
    ...profileSnapshot("needs-upgrade"),
    generation: 5,
    states: [
      {
        profileId: PROFILE_ID,
        sourceServerId: SOURCE_ID,
        state: "needs-upgrade",
        upgradeTarget: "server",
        availableVersion: "3.16.2",
        runningTasks: [{ sessionId: "task-1", workspacePath: "/srv/repo" }],
        updatedAt: 1,
      },
    ],
  };
}

function clone(value) {
  return structuredClone(value);
}

function sanitizeCreatedTarget(target) {
  if (target.kind !== "ssh") return target;
  const { password: _password, privateKeyPassphrase: _passphrase, ...rest } = target;
  return { ...rest, passwordCredentialKey: "source-server:created:password" };
}

const management = {
  onDidChangeState: () => ({ dispose() {} }),
  onDidChangeDirectory: () => ({ dispose() {} }),
  onDidAppendOperationLog: () => ({ dispose() {} }),
  async getSnapshot() {
    events.push({ type: "getSnapshot" });
    return clone(snapshot);
  },
  async getRecentOperationLogs() {
    return [];
  },
  async createProfile(input) {
    events.push({ type: "createProfile", input: clone(input) });
    snapshot = {
      ...baseSnapshot({ generation: 2 }),
      profiles: [
        {
          profileId: PROFILE_ID,
          transport: input.target.kind,
          target: sanitizeCreatedTarget(input.target),
          displayName: input.profileDisplayName ?? "Created profile",
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      states: [{ profileId: PROFILE_ID, state: "offline", updatedAt: 1 }],
    };
    return clone(snapshot);
  },
  async connectProfile(profileId, options = {}) {
    events.push({ type: "connectProfile", profileId, options: clone(options) });
    if (scenario === "install") {
      if (options.confirmSourceServerInstall) {
        throw codeError("remote-target-changed", "target changed while confirming");
      }
      snapshot = installSnapshot();
      throw codeError("source-server-install-required", "install required");
    }
    if (scenario === "force" && !options.confirmSourceServerInstall) {
      snapshot = runningSnapshot();
      throw codeError("source-server-update-running-tasks", "tasks are running");
    }
    snapshot = onlineSnapshot();
    return clone(snapshot);
  },
  async updateSource(input) {
    events.push({ type: "updateSource", input: clone(input) });
    snapshot = onlineSnapshot();
    return clone(snapshot);
  },
  async disconnect() {
    return clone(profileSnapshot("offline"));
  },
  async removeProfile() {
    snapshot = baseSnapshot();
    return clone(snapshot);
  },
  async removeSource() {
    snapshot = baseSnapshot();
    return clone(snapshot);
  },
  async renameSource() {
    return clone(snapshot);
  },
  async renameProfile() {
    return clone(snapshot);
  },
  async updateProfile() {
    return clone(snapshot);
  },
  async setPreferredProfile() {
    return clone(snapshot);
  },
  async confirmIdentityChange() {
    return clone(snapshot);
  },
  async connectSource() {
    snapshot = onlineSnapshot();
    return clone(snapshot);
  },
};

const credentialLoad = async (key) => {
  events.push({ type: "credentialLoad", key });
  return key === "source-server:profile:password" ? "profile-secret" : null;
};
const services = {
  sourceServerManagementService: management,
  credentialService: { load: credentialLoad },
  settingService: { get: async () => ({}) },
  skillSyncService: {},
  mcpSyncService: {},
  pluginSyncService: {},
  zcodeAgentService: { listTasks: async () => [] },
};
const platform = {
  kind: "web",
  isDesktop: false,
  selectDirectory: async () => null,
  selectFile: async () => null,
  onRemoteConnectionLog: () => () => {},
  onRemoteSessionClosed: () => () => {},
  onBotRemoteWorkspaceReconnected: () => () => {},
  onWebRemoteControlStatusChanged: () => () => {},
  onWebRemoteControlReconnectWorkspace: () => () => {},
  activateOrSetWorkspace: async () => ({ activated: false }),
  connectRemote: async () => ({ success: false, error: "fixture must not connect" }),
  cancelPendingRemoteConnection: async () => {
    events.push({ type: "cancelPendingConnection" });
  },
  disposeRemoteSession: async () => {},
  startWebRemoteControl: async () => ({}),
  stopWebRemoteControl: async () => {},
  getWebRemoteControlStatus: async () => ({}),
  refreshWebRemoteControlPairing: async () => ({}),
  syncWebRemoteControlWorkspaces: async () => {},
  syncWebRemoteControlTasks: async () => {},
  isDockerAvailable: async () => false,
  listWSLDistros: async () => [],
  listDockerContainers: async () => [],
  listSSHConfigAliases: async () => [],
  openExternal: () => {},
  openFeedback: async () => {},
  openCommunity: async () => {},
  canOpenCommunity: async () => false,
  openInFileManager: async () => ({ success: false }),
  getDefaultHomeDir: async () => "/home/dev",
};

const connectedTargets = new Map();
const serverWorkspaceHistory = [];
const directoryServices = {
  systemService: { info: async () => ({ homedir: "/srv/app" }) },
  fileService: { readdir: async () => [] },
  credentialService: { load: async () => null },
};

async function routeHost(target) {
  // 浏览器内的假 routeHost：真实 loopback HTTP server-info 返回已鉴权 id，
  // 之后按 Host/Main descriptor 契约覆盖表单里缺失/错误的 serverId。
  const base = new URL(target.url);
  const basePath = base.pathname.replace(/\/+$/, "");
  const infoUrl = new URL(basePath + "/api/server-info", base.origin);
  const response = await fetch(infoUrl, {
    headers: target.token ? { authorization: "Bearer " + target.token } : {},
  });
  if (!response.ok) {
    throw new Error("server-info failed: " + response.status);
  }
  const info = await response.json();
  const connectedTarget = { ...target, serverId: info.serverId };
  const sessionId = "session-" + info.serverId;
  connectedTargets.set(sessionId, connectedTarget);
  registerRemoteWorkspaceSession({
    sessionId,
    target: connectedTarget,
    services: directoryServices,
  });
  events.push({
    type: "handshake",
    advertised: target.serverId ?? null,
    authenticated: info.serverId,
    sessionId,
  });
  return { sessionId, target: connectedTarget, sourceServerId: info.serverId };
}

function App() {
  const dialogServices = useMemo(() => services, []);
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={dialogServices}>
        <ZCodeIntlProvider initialLocale="en-US">
          <SSHDialog
            onConnect={(target, requestId) => {
              events.push({ type: "onConnect", target: clone(target), requestId });
              if (scenario === "server-identity" || scenario === "server-late-identity") {
                return new Promise((resolve, reject) => {
                  setTimeout(
                    () => {
                      routeHost(target)
                        .then((connected) => {
                          events.push({
                            type: "session-created",
                            target: clone(connected.target),
                            sourceServerId: connected.sourceServerId,
                            requestId,
                          });
                          resolve(connected.sessionId);
                        })
                        .catch(reject);
                    },
                    scenario === "server-late-identity" ? 700 : 0,
                  );
                });
              }
              if (scenario === "background" || scenario === "late-cancel") {
                return new Promise((resolve) => {
                  setTimeout(
                    () => {
                      events.push({ type: "session-created", target: clone(target), requestId });
                      resolve("fixture-session");
                    },
                    scenario === "late-cancel" ? 700 : 500,
                  );
                });
              }
              events.push({ type: "session-created", target: clone(target), requestId });
              return Promise.resolve("fixture-session");
            }}
            onSelectProject={async (sessionId, path) => {
              events.push({ type: "selectProject", sessionId, path });
              if (scenario === "server-identity") {
                const connectedTarget = connectedTargets.get(sessionId);
                if (!connectedTarget) throw new Error("missing routed target");
                const identity = buildRemoteWorkspaceIdentity(path, connectedTarget);
                const mutation = buildRemoteWorkspaceSessionMutation({
                  remoteSessions: serverWorkspaceHistory,
                  workspacePath: path,
                  workspaceIdentity: identity,
                  target: connectedTarget,
                  lastConnectionStatus: "connected",
                  touchOpenedAt: true,
                });
                serverWorkspaceHistory.splice(0, serverWorkspaceHistory.length, ...mutation.nextRemoteSessions);
                const tokenKey =
                  mutation.entry.target.kind === "server"
                    ? mutation.entry.target.tokenCredentialKey
                    : undefined;
                events.push({
                  type: "workspaceMutation",
                  identity,
                  name: connectedTarget.name,
                  tokenKey,
                  credentialKeys: mutation.credentialsToSave.map((item) => item.key),
                  historySize: serverWorkspaceHistory.length,
                });
              }
            }}
            onCancelSession={async (sessionId) => {
              events.push({ type: "cancelSession", sessionId });
              unregisterRemoteWorkspaceSession(sessionId);
            }}
            localWorkspacePath="/local"
          />
        </ZCodeIntlProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);

`;
const fixtureEntry = resolve(fixtureDir, "source-management-e2e.tsx");
await writeFile(fixtureEntry, fixtureSource);
const output = await build({
  absWorkingDir: root,
  entryPoints: [fixtureEntry],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.PROD": "true",
    "import.meta.env.DEV": "false",
    "import.meta.env.MODE": '"production"',
  },
});
const built = output.outputFiles[0];
assert.ok(built?.contents, "Source UI fixture bundle was not produced");
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (pathname === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(built.contents);
    return;
  }
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
    );
    return;
  }
  const sourceInfo = pathname.match(/^\/(source-[a-z]+)\/api\/server-info$/u);
  if (sourceInfo) {
    const serverId = sourceInfo[1] === "source-a" ? "source-a-id" : "source-b-id";
    if (request.headers.authorization !== "Bearer server-secret-token") {
      response.statusCode = 401;
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        serverId,
        name: "Same Name",
        version: "3.16.2",
        protocolVersion: 1,
        authRequired: true,
        compatibility: {
          schemaVersion: 1,
          productVersion: "3.16.2",
          minCompatibleVersion: "3.15.1",
        },
        capabilities: { desktopContinuous: true, websocketRpc: true, virtualProjects: true },
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end("not found");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

function pageEvents(page) {
  return page.evaluate(() => window.__sourceEvents);
}

async function waitForEvent(page, type) {
  await page.waitForFunction(
    (expected) => window.__sourceEvents.some((event) => event.type === expected),
    type,
  );
}

async function waitForEventCount(page, type, count) {
  await page.waitForFunction(
    (expected) =>
      window.__sourceEvents.filter((event) => event.type === expected.type).length >=
      expected.count,
    { type, count },
  );
}

async function openServerForm(page, options) {
  if (options.reload) {
    await page.goto(`${origin}/?scenario=${options.scenario}`);
  }
  await page.getByTestId("ssh-connect-trigger").click();
  await page.getByTestId("ssh-dialog").waitFor();
  await page.getByTestId("remote-kind-server").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByTestId("server-url-input").fill(options.url);
  await page.getByTestId("server-name-input").fill(options.name);
  await page.getByTestId("server-token-input").fill("server-secret-token");
  await page.getByTestId("server-workspace-path-input").fill("/srv/app");
}

async function connectServerSource(page, options) {
  await openServerForm(page, options);
  await page.getByTestId("ssh-connect-button").click();
  await page.getByTestId("ssh-success").waitFor();
  await page.getByRole("button", { name: "Select this directory", exact: true }).click();
}

async function openSshSettings(page, scenario) {
  await page.goto(`${origin}/?scenario=${scenario}`);
  await page.getByTestId("ssh-connect-trigger").click();
  await page.getByTestId("ssh-dialog").waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByTestId("ssh-host-input").fill("host.example");
  await page.getByTestId("ssh-port-input").fill("22");
  await page.getByTestId("ssh-username-input").fill("dev");
  await page.getByTestId("ssh-password-input").fill("secret-password");
}

let browser;
try {
  browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  const externalRequests = [];
  const pageErrors = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (!["data:", "blob:"].includes(url.protocol) && url.hostname !== "127.0.0.1") {
      externalRequests.push(request.url());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
  });

  // 1. install preview -> explicit confirm -> target changed mid-confirm -> zero execute.
  await openSshSettings(page, "install");
  await page.getByTestId("ssh-connect-button").click();
  await page.getByTestId("source-install-panel").waitFor();
  assert.match(await page.getByTestId("source-install-version").innerText(), /3\.16\.2/u);
  assert.match(await page.getByTestId("source-install-path").innerText(), /\/home\/dev\/\.zcode/u);
  let events = await pageEvents(page);
  assert.equal(
    events.some((event) => event.type === "onConnect"),
    false,
  );
  await page.getByTestId("source-install-confirm").click();
  await page
    .getByTestId("ssh-error")
    .getByText(/Connection target changed/u)
    .waitFor();
  events = await pageEvents(page);
  const installConnects = events.filter((event) => event.type === "connectProfile");
  assert.equal(installConnects.length, 2);
  assert.deepEqual(installConnects[1].options, {
    confirmSourceServerInstall: true,
    expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
  });
  assert.equal(
    events.some((event) => event.type === "onConnect"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "selectProject"),
    false,
  );

  // 2. minimized success waits for explicit Continue; no auto navigation.
  await openSshSettings(page, "background");
  await page.getByTestId("ssh-connect-button").click();
  await page.getByRole("button", { name: "Minimize remote connection window" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId("ssh-success").count(), 0);
  events = await pageEvents(page);
  assert.equal(
    events.some((event) => event.type === "session-created"),
    true,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByTestId("ssh-success").waitFor();

  // 3. close while an await is pending: late success only releases its own session.
  await openSshSettings(page, "late-cancel");
  await page.getByTestId("ssh-connect-button").click();
  await page.getByTestId("ssh-dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForFunction(() => window.__hasPendingConfirm());
  await page.evaluate(() => window.__settleConfirm(true));
  await waitForEvent(page, "cancelSession");
  await page.waitForTimeout(900);
  events = await pageEvents(page);
  assert.equal(events.filter((event) => event.type === "session-created").length, 1);
  assert.deepEqual(
    events.filter((event) => event.type === "cancelSession").map((event) => event.sessionId),
    ["fixture-session"],
  );
  assert.equal(
    events.some((event) => event.type === "selectProject"),
    false,
  );
  assert.equal(await page.getByTestId("ssh-success").count(), 0);

  // 4. direct server URL/token is a real target, not a profile and not persisted.
  await page.goto(`${origin}/?scenario=server`);
  await page.getByTestId("ssh-connect-trigger").click();
  await page.getByTestId("remote-kind-server").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByTestId("server-url-input").fill("  https://studio.example:3030  ");
  await page.getByTestId("server-name-input").fill("  Studio  ");
  await page.getByTestId("server-token-input").fill("  server-secret-token  ");
  await page.getByTestId("server-workspace-path-input").fill("  /srv/app  ");
  await page.getByTestId("ssh-connect-button").click();
  await waitForEvent(page, "session-created");
  events = await pageEvents(page);
  const serverConnect = events.find((event) => event.type === "onConnect");
  assert.deepEqual(serverConnect.target, {
    kind: "server",
    url: "https://studio.example:3030",
    name: "Studio",
    token: "server-secret-token",
    workspacePath: "/srv/app",
  });
  assert.equal(
    events.some((event) => event.type === "createProfile" || event.type === "connectProfile"),
    false,
  );
  const persisted = await page.evaluate(() => JSON.stringify(localStorage));
  assert.equal(persisted.includes("server-secret-token"), false);
  await page.getByTestId("ssh-success").waitFor();

  // 4b. real Source form (no serverId) routed through fake loopback Host/Main handshake:
  // same display name + same path but different authenticated ids stay distinct.
  await connectServerSource(page, {
    reload: true,
    scenario: "server-identity",
    url: `${origin}/source-a`,
    name: "Same Name",
  });
  await waitForEventCount(page, "workspaceMutation", 1);
  await connectServerSource(page, {
    reload: false,
    scenario: "server-identity",
    url: `${origin}/source-b`,
    name: "Same Name",
  });
  await waitForEventCount(page, "workspaceMutation", 2);
  // Rename Source A: display-only change must not churn identity/token slot.
  await connectServerSource(page, {
    reload: false,
    scenario: "server-identity",
    url: `${origin}/source-a`,
    name: "Renamed Studio",
  });
  await waitForEventCount(page, "workspaceMutation", 3);
  events = await pageEvents(page);
  const identityMutations = events.filter((event) => event.type === "workspaceMutation");
  assert.deepEqual(
    identityMutations.map((event) => event.identity),
    [
      "remote:server:source-a-id:/srv/app",
      "remote:server:source-b-id:/srv/app",
      "remote:server:source-a-id:/srv/app",
    ],
  );
  assert.notEqual(identityMutations[0].tokenKey, identityMutations[1].tokenKey);
  assert.equal(identityMutations[2].tokenKey, identityMutations[0].tokenKey);
  assert.deepEqual(identityMutations[2].credentialKeys, [identityMutations[0].tokenKey]);
  assert.equal(identityMutations[2].name, "Renamed Studio");
  assert.equal(identityMutations[2].historySize, 2);
  const handshakes = events.filter((event) => event.type === "handshake");
  assert.deepEqual(
    handshakes.map((event) => [event.advertised, event.authenticated]),
    [
      [null, "source-a-id"],
      [null, "source-b-id"],
      [null, "source-a-id"],
    ],
  );

  // 4c. late success after close only releases its own session; no history/credential write.
  await openServerForm(page, {
    reload: true,
    scenario: "server-late-identity",
    url: `${origin}/source-a`,
    name: "Same Name",
  });
  await page.getByTestId("ssh-connect-button").click();
  await page.getByTestId("ssh-dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForFunction(() => window.__hasPendingConfirm());
  await page.evaluate(() => window.__settleConfirm(true));
  await waitForEvent(page, "cancelSession");
  await page.waitForTimeout(900);
  events = await pageEvents(page);
  assert.equal(
    events.some((event) => event.type === "workspaceMutation"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "selectProject"),
    false,
  );
  assert.deepEqual(
    events.filter((event) => event.type === "cancelSession").map((event) => event.sessionId),
    ["session-source-a-id"],
  );

  // 5. running-task force only after explicit confirm; updateSource receives force + frozen target.
  await openSshSettings(page, "force");
  await page.getByTestId("ssh-connect-button").click();
  await page.getByTestId("source-force-panel").waitFor();
  events = await pageEvents(page);
  assert.equal(
    events.some((event) => event.type === "updateSource"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "onConnect"),
    false,
  );
  await page.getByTestId("source-force-confirm").click();
  await waitForEvent(page, "session-created");
  events = await pageEvents(page);
  const update = events.find((event) => event.type === "updateSource");
  assert.deepEqual(update.input, {
    profileId: "22222222-2222-4222-8222-222222222222",
    force: true,
    expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
  });
  const forcedConnect = events.filter((event) => event.type === "connectProfile").at(-1);
  assert.equal(forcedConnect.options.confirmSourceServerInstall, true);
  assert.ok(
    events.indexOf(update) < events.lastIndexOf(forcedConnect),
    "force update must run before the confirmed reconnect",
  );
  await page.getByTestId("ssh-success").waitFor();

  // 6. saved profile reconnect reads credentials only from the credential port.
  await openSshSettings(page, "profile");
  await page.getByTestId("source-profile-list").waitFor();
  await page
    .getByTestId(`source-profile-item-22222222-2222-4222-8222-222222222222`)
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await waitForEvent(page, "session-created");
  events = await pageEvents(page);
  assert.equal(
    events.some(
      (event) => event.type === "credentialLoad" && event.key === "source-server:profile:password",
    ),
    true,
  );
  const profileConnect = events.find((event) => event.type === "onConnect");
  assert.equal(profileConnect.target.password, "profile-secret");
  assert.equal(JSON.stringify(profileConnect.target).includes("profile-secret"), true);
  await page.getByTestId("ssh-success").waitFor();

  assert.deepEqual(externalRequests, [], "source UI smoke must not request external network");
  assert.deepEqual(pageErrors, [], "source UI smoke must not emit uncaught browser errors");
  console.log(
    "PASS real Source UI browser flow: install preview + expectedTarget race zero execute; background explicit continue; late close only releases own session; server token target not profile/persisted; same-name Sources keep handshake ids/paths distinct and rename stable; late Source success writes no history; force only after confirm; saved profile credentials via credential port",
  );
  console.log("Rerun: node scripts/ci/source-management-ui-smoke.mjs");
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(fixtureDir, { recursive: true, force: true });
  }
}
