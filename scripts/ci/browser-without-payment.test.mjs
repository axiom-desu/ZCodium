import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const electronMock = `
import { EventEmitter } from 'node:events';
export const opened = [];
export const app = { isPackaged: true };
export const nativeTheme = { shouldUseDarkColors: false };
export const nativeImage = {};
export const Menu = {};
export const shell = { openExternal: async url => { opened.push(url); } };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 900 } }) };
export class Guest extends EventEmitter {
  id = 7;
  sent = [];
  setZoomFactor() {}
  send(...args) { this.sent.push(args); }
  setWindowOpenHandler(handler) { this.popup = handler; }
}
export class BrowserWindow extends EventEmitter {
  webContents = new Guest();
  constructor(options) { super(); this.options = options; }
  isDestroyed() { return false; }
  maximize() {}
}
// pluginSandbox 的 host/session 会被 desktopWindowChrome 的依赖图带进这个 bundle。
// 它们从 electron 取的符号此前不在 mock 里，esbuild 直接 "No matching export"
// 构建失败——本用例只验证浏览器访客隔离与对话框 preload，不需要沙箱真实行为，
// 因此这里只补到「能被解析」的最小形状，不模拟任何语义。
export const clipboard = { writeImage: async () => {}, readText: async () => "" };
export const MessageChannelMain = {};
export const dialog = { showMessageBox: async () => ({ response: 0 }) };
export const session = { fromPartition: () => ({}) };
export const webContents = { fromId: () => undefined };
export const ipcMain = { handle: () => {} };
export const systemPreferences = {
  getMediaAccessStatus: () => "granted",
  askForMediaAccess: async () => true,
};
`;
const result = await build({
  stdin: {
    contents: `export { createBrowserWindow } from './packages/desktop/src/main/desktopWindowChrome.ts'; export { Guest, opened } from 'electron';`,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node24",
  define: { "import.meta.dirname": JSON.stringify("/fixture/out/main") },
  plugins: [
    {
      name: "native-window-fixture",
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({
          path: "electron",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: electronMock,
          loader: "js",
        }));
        builder.onResolve({ filter: /desktopHostProcess\.js$/ }, () => ({
          path: "host",
          namespace: "host-fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "host-fixture" }, () => ({
          contents: "export async function loadWindow() {}",
          loader: "js",
        }));
      },
    },
  ],
});
const { createBrowserWindow, Guest, opened } = await import(
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64")
);

test("all browser guests keep isolation and the ordinary dialog preload, with no payment exception", () => {
  const window = createBrowserWindow({
    iconPath: "/fixture/icon",
    preloadPath: "/fixture/app",
    logger: { warn() {} },
    resolveBrowserViewOwner: () => ({
      workspaceKey: "fixture-workspace",
      sessionId: "fixture-session",
      browserId: "browser",
      browserGeneration: 3,
      tabId: "tab",
    }),
  });
  for (const src of [
    "https://zcode.z.ai/coding-plan?embedded=app",
    "https://example.invalid/",
    "about:blank",
  ]) {
    const preferences = { preload: "/untrusted", nodeIntegration: true, sandbox: false };
    const params = {
      src,
      preload: "/untrusted",
      disablewebsecurity: "true",
      nodeintegration: "true",
    };
    window.webContents.emit(
      "will-attach-webview",
      {
        preventDefault() {
          assert.fail("valid page was blocked");
        },
      },
      preferences,
      params,
    );
    assert.match(preferences.preload, /embeddedBrowserJavaScriptDialog\.cjs$/);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(params.preload, undefined);
    assert.equal(params.disablewebsecurity, undefined);
  }
  let blocked = false;
  window.webContents.emit(
    "will-attach-webview",
    {
      preventDefault() {
        blocked = true;
      },
    },
    {},
    { src: "file:///private/file" },
  );
  assert.equal(blocked, true);
  const guest = new Guest();
  window.webContents.emit("did-attach-webview", {}, guest);
  assert.deepEqual(guest.popup({ url: "javascript:alert(1)", disposition: "new-window" }), {
    action: "deny",
  });
  assert.equal(window.webContents.sent.length, 0);
  guest.popup({ url: "https://example.invalid/page", disposition: "foreground-tab" });
  const routed = window.webContents.sent.at(-1)[1];
  assert.equal(routed.url, "https://example.invalid/page");
  assert.equal(routed.workspaceKey, "fixture-workspace");
  assert.equal(routed.browserGeneration, 3);
  guest.popup({ url: "https://example.invalid/external", disposition: "background-tab" });
  assert.deepEqual(opened, ["https://example.invalid/external"]);
});
