import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import { tsImport } from "tsx/esm/api";

const shared = await tsImport("../../packages/shared/src/index.ts", import.meta.url);
const urls = await tsImport(
  "../../packages/desktop/src/main/desktopDeepLinkUrl.ts",
  import.meta.url,
);
const mainPath = "packages/desktop/src/main/";
const plain = (value) => JSON.parse(JSON.stringify(value));
async function load(file, imports, globals = {}) {
  const { code } = await transform(
    await readFile(new URL(`../../${file}`, import.meta.url), "utf8"),
    {
      loader: "ts",
      format: "cjs",
      target: "node24",
    },
  );
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    URL,
    process,
    require(name) {
      assert.ok(name in imports, `Unexpected dependency: ${name}`);
      return imports[name];
    },
    setTimeout() {
      assert.fail("Deep links must not start an OAuth expiry timer");
    },
    ...globals,
  });
  return module.exports;
}

test("single-instance forwarding accepts workspace links and drops retired login payloads", () => {
  const retired = "zcode://oauth/callback?state=fixture-state&code=fixture-code";
  for (const url of [
    retired,
    "zcode:/oauth/callback?authCode=fixture-code",
    "zcode://unknown/open?code=fixture-code",
  ]) {
    for (const value of [
      url,
      encodeURIComponent(url),
      encodeURIComponent(encodeURIComponent(url)),
    ]) {
      assert.equal(urls.extractDeepLinkUrlFromArgs(["app", value]), null);
      assert.deepEqual(urls.createDeepLinkSingleInstanceData([value]), {});
      assert.equal(urls.extractDeepLinkUrlFromSingleInstanceData({ deepLinkUrl: value }), null);
    }
  }
  const workspace = "zcode://workspace/open?path=%2Ftmp%2Ffixture%20project";
  for (const value of [
    workspace,
    `"${workspace}"`,
    encodeURIComponent(encodeURIComponent(workspace)),
  ]) {
    const parsed = new URL(urls.extractDeepLinkUrlFromArgs(["app", value]));
    assert.equal(urls.extractWorkspaceOpenPath(parsed), "/tmp/fixture project");
  }
  assert.equal(
    urls.extractDeepLinkUrlFromArgs(["zcode://workspace/open", "?path=%2Ftmp"]),
    "zcode://workspace/open?path=%2Ftmp",
  );
  assert.equal(
    urls.extractWorkspaceOpenPath(new URL("zcode:/workspace/open/?path=%2Ftmp")),
    "/tmp",
  );
  assert.equal(urls.extractOpenWorkspacePathFromArgs(["--open-workspace", 'C:"']), "C:\\");
  assert.equal(
    urls.extractOpenWorkspacePathFromArgs(['--open-workspace="C:\\fixture project"']),
    "C:\\fixture project",
  );
});

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "zcodium-deep-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [],
    logs = [],
    timers = [];
  const app = new EventEmitter();
  let windows = [],
    response = 0;
  const electron = {
    app,
    BrowserWindow: { getFocusedWindow: () => windows[0] ?? null, getAllWindows: () => windows },
    dialog: {
      showMessageBoxSync(...args) {
        calls.push(["confirm", args.at(-1)]);
        return response;
      },
    },
  };
  const router = await load(
    `${mainPath}desktopOAuthDeepLink.ts`,
    {
      electron,
      "node:path": path,
      "node:fs": {
        statSync(value) {
          calls.push(["stat", value]);
          return statSync(value);
        },
      },
      "@zcode/shared": shared,
      "./desktopDeepLinkUrl.js": urls,
      "../../scripts/desktop-product-identity.mjs": {},
      "./desktopLinuxDeepLinkRegistration.js": {},
    },
    {
      setTimeout(...args) {
        timers.push(args);
      },
    },
  );
  const logger = { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) };
  const window = (id) => {
    const win = new EventEmitter();
    win.webContents = { id, send: (...args) => calls.push(["send", id, ...args]) };
    Object.assign(win, {
      isMinimized: () => true,
      isVisible: () => false,
      restore: () => calls.push(["restore", id]),
      show: () => calls.push(["show", id]),
      focus: () => calls.push(["focus", id]),
    });
    return win;
  };
  return {
    directory,
    router,
    electron,
    calls,
    logs,
    timers,
    logger,
    window,
    setWindows: (value) => {
      windows = value;
    },
    setResponse: (value) => {
      response = value;
    },
    link: `zcode://workspace/open?path=${encodeURIComponent(directory)}`,
  };
}

test("retired callbacks cannot be cached, delivered or logged by Main", async (t) => {
  const h = await harness(t);
  for (const url of [
    "zcode://oauth/callback?state=fixture-private-state&code=fixture-private-code",
    "zcode:/oauth/callback?state=fixture-private-state&authCode=fixture-private-code",
    "invalid fixture-private-code",
  ])
    assert.equal(h.router.handleDeepLink(url, h.logger), false);
  const win = h.window(1);
  h.router.deliverPendingWorkspaceOpen(win.webContents);
  assert.deepEqual(h.calls, []);
  assert.doesNotMatch(JSON.stringify(h.logs), /fixture-private/);
  assert.deepEqual(h.timers, []);
});

test("workspace routing preserves consent, readiness, window isolation and close cleanup", async (t) => {
  const h = await harness(t);
  const a = h.window(1),
    b = h.window(2);
  h.setWindows([a, b]);
  assert.equal(h.router.handleDeepLink(h.link, h.logger), true);
  assert.deepEqual(
    h.calls.slice(0, 2).map(([event]) => event),
    ["confirm", "stat"],
  );
  h.router.deliverPendingWorkspaceOpen(b.webContents);
  assert.equal(h.calls.filter(([event]) => event === "send").length, 0);
  h.router.deliverPendingWorkspaceOpen(a.webContents);
  h.router.deliverPendingWorkspaceOpen(a.webContents);
  assert.deepEqual(
    h.calls.filter(([event]) => event === "send"),
    [["send", 1, shared.PlatformChannels.OpenWorkspacePath, h.directory]],
  );
  assert.ok(h.calls.some(([event, id]) => event === "focus" && id === 1));
  h.router.clearWorkspaceDeepLinkStateForWindow(1);
  h.calls.length = 0;
  h.router.handleDeepLink(h.link, h.logger);
  h.router.clearWorkspaceDeepLinkStateForWindow(1);
  h.router.deliverPendingWorkspaceOpen(b.webContents);
  h.router.deliverPendingWorkspaceOpen(a.webContents);
  assert.equal(h.calls.filter(([event]) => event === "send").length, 0);
  h.setWindows([]);
  h.router.handleDeepLink(h.link, h.logger);
  h.router.deliverPendingWorkspaceOpen(b.webContents);
  h.router.deliverPendingWorkspaceOpen(a.webContents);
  assert.deepEqual(
    h.calls.filter(([event]) => event === "send"),
    [["send", 2, shared.PlatformChannels.OpenWorkspacePath, h.directory]],
  );
  h.calls.length = 0;
  h.setWindows([b]);
  h.setResponse(1);
  assert.equal(h.router.handleDeepLink(h.link, h.logger), true);
  assert.deepEqual(
    h.calls.map(([event]) => event),
    ["confirm"],
  );
  assert.equal(h.calls[0][1].cancelId, 1);
  h.calls.length = 0;
  h.setResponse(0);
  assert.equal(
    h.router.handleDeepLink("zcode://workspace/open?path=%2F%2Fserver%2Fshare", h.logger),
    false,
  );
  assert.deepEqual(h.calls, []);
  let blocked = false;
  h.router.handleDeepLink(h.link, h.logger, {
    canOpenWorkspace: () => false,
    onWorkspaceOpenBlocked: () => {
      blocked = true;
    },
  });
  assert.equal(blocked, true);
  assert.deepEqual(h.calls, []);
  // Retry goes straight to the ready business window, excluding a helper window.
  h.router.handleDeepLink(h.link, h.logger, { resolveApplicationWindow: () => b });
  assert.deepEqual(
    h.calls.filter(([event]) => event === "send"),
    [["send", 2, shared.PlatformChannels.OpenWorkspacePath, h.directory]],
  );
});

test("real IPC registration retains renderer-ready and close handling without login channels", async (t) => {
  const h = await harness(t);
  const listeners = new Map();
  h.electron.ipcMain = { on: (name, fn) => listeners.set(name, fn), handle() {} };
  const { registerRemoteIpcHandlers } = await load(`${mainPath}desktopMainIpcRemote.ts`, {
    electron: h.electron,
    "@zcode/shared": shared,
    "./desktopOAuthDeepLink.js": h.router,
    "./desktopNotifications.js": {},
    "./desktopMainIpcHelpers.js": {},
    // 既定 3.16 行为（upstream-3.16-source-server.md「source-settings attachment 的 Main 入口」）：
    // registerRemoteIpcHandlers 通过 ./sourceSettingsAttachmentRequest.js 注册
    // RequestSourceSettingsAttachment handler，同目录既有依赖一致补登记 stub；
    // 本测试不触发该通道，stub 仅充当前端依赖。
    "./sourceSettingsAttachmentRequest.js": { dispatchSourceSettingsAttachment: () => {} },
    "./desktopProviderConfig.js": {
      getBuiltinProviderConfigFileInfo: () => ({ path: null, exists: false }),
    },
  });
  registerRemoteIpcHandlers({ logger: h.logger });
  assert.equal(listeners.has("zcode:oauth-register-state"), false);
  const a = h.window(4);
  h.setWindows([a]);
  h.electron.app.emit("browser-window-created", {}, a);
  h.router.handleDeepLink(h.link, h.logger);
  const ready = listeners.get(shared.PlatformChannels.RendererReady);
  ready({ sender: a.webContents });
  ready({ sender: a.webContents });
  assert.deepEqual(
    h.calls.filter(([event]) => event === "send"),
    [["send", 4, shared.PlatformChannels.OpenWorkspacePath, h.directory]],
  );
  a.emit("closed");
  h.calls.length = 0;
  h.router.handleDeepLink(h.link, h.logger);
  const contents = a.webContents;
  Object.defineProperty(a, "webContents", {
    get() {
      throw new Error("Object destroyed");
    },
  });
  a.emit("closed");
  ready({ sender: contents });
  assert.equal(h.calls.filter(([event]) => event === "send").length, 0);
});

test("public platform and preload no longer expose proprietary OAuth callbacks", async () => {
  for (const file of [
    "packages/shared/src/platform.ts",
    "packages/shared/src/channels.ts",
    "packages/shared/src/oauth.ts",
    "packages/client/src/globals.d.ts",
    "packages/desktop/src/preload/index.ts",
    "packages/desktop/src/renderer/src/desktopPlatform.ts",
    "packages/web/src/main.tsx",
  ]) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /registerOAuthState|onOAuthCallback|OAuthRegisterState|OAuthStateRegistration|createOAuthCallbackHandler/,
    );
  }
  assert.equal(shared.PlatformChannels.OAuthCallback, undefined);
  assert.equal(shared.PlatformChannels.OAuthRegisterState, undefined);
  assert.deepEqual(
    plain(urls.createDeepLinkSingleInstanceData(["--open-workspace=/tmp/fixture"])),
    { openWorkspacePath: "/tmp/fixture" },
  );
});
