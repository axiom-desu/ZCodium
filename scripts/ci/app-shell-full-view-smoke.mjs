import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const TID_SIDE_PANE_FULL_VIEW_HOST = "side-pane-full-view-host";
const TID_SIDE_PANE_FULL_VIEW_TOGGLE = "side-pane-full-view-toggle";
const TID_SIDE_PANE_TOGGLE = "side-pane-toggle";

// App/WorkspaceShellLayout 结构集成守卫（spec：docs/specs/side-pane-full-view.md）。
// 使用真实 App、WorkspaceShellLayout、useSidePaneFullView、taskSidePaneMemory 与完整视图宿主；
// 只替换重型展示叶子和面板内容，避免把组件级 E2E 的业务断言复制进本守卫。
const root = resolve(import.meta.dirname, "../..");
const fixtureDir = resolve(root, "packages/ui/test/fixtures");
// 复用 packages/services 已声明的 esbuild，不把构建工具提升成新的根依赖。
const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
const leaves = resolve(fixtureDir, "app-shell-leaves.jsx");
const aliases = [
  "root/DiffsWorkerPoolProvider",
  "SettingsPage",
  "onboarding/OccupationOnboarding",
  "onboarding/OnboardingDialog",
  "SSHDialog",
  "DirectoryBrowser",
  "cua-permission/CuaPermissionObservationAttachment",
  "app-shell/AnimatedTerminalPanel",
  "WorkspaceHeader",
  "WorkspaceSidebar",
  "v4/V4WorkspaceChatArea",
  "PreviewPane",
  "SidePaneTerminalPane",
  "browser-use/BrowserUseSidePaneContent",
  "browser-use/HumanBrowserView",
  "GitPane",
  "TreemappingPane",
  "WhiteboardPane",
  "ModelTrajectoryPane",
  "DeveloperToolsPane",
  "app-shell/SidePaneTabOverview",
  "app-shell/SubagentSessionSidePane",
  "app-shell/SubagentDirectorySidePane",
  "app-shell/SelectionSideChatPane",
  "app-shell/BackgroundBashOutputSidePane",
  "app-shell/PlanDetailSidePane",
  "app-shell/WorkflowRunSidePane",
  "app-shell/WorkflowRunDirectorySidePane",
  "app-shell/WorkflowActorSessionSidePane",
  "app-shell/WorkflowWorkspaceSidePane",
  "app-shell/WorkflowArtifactSidePane",
];
const outputs = await build({
  absWorkingDir: root,
  entryPoints: [resolve(fixtureDir, "app-shell-full-view.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: {
    "@/side-pane-full-view/index.js": resolve(root, "packages/ui/src/side-pane-full-view/index.js"),
    "@/app-shell/AnimatedSidePanePanel.js": resolve(fixtureDir, "app-shell-side-pane-panel.jsx"),
    ...Object.fromEntries(aliases.map((name) => [`@/${name}.js`, leaves])),
    "@": resolve(root, "packages/ui/src"),
  },
  outdir: resolve(root, "node_modules/.cache/app-shell-full-view"),
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.PROD": "true",
    "import.meta.env.DEV": "false",
    "import.meta.env.MODE": '"production"',
  },
});
const built = outputs.outputFiles.find((file) => file.path.endsWith(".js"));
assert.ok(built?.contents, "App shell fixture bundle was not produced");
const script = built.contents;
const assetDir =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const styleName = (await readdir(assetDir)).find((name) => /^styles-.*\.css$/.test(name));
assert.ok(styleName, "Build the desktop renderer before running the app shell guard");
const css = await readFile(resolve(assetDir, styleName), "utf8");
const logo = await readFile(resolve(root, "public/logo/icons/512x512.png"));
const server = createServer((request, response) => {
  if (request.url === "/public/logo/icons/512x512.png") {
    response.setHeader("Content-Type", "image/png");
    response.end(logo);
    return;
  }
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
    return;
  }
  if (request.url === "/styles.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
    return;
  }
  if (request.url?.startsWith("/assets/")) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.clear());
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByTestId("app-shell-chat-area").waitFor();
  const host = page.getByTestId(TID_SIDE_PANE_FULL_VIEW_HOST);
  const hostMode = () => host.getAttribute("data-side-pane-full-view-host");
  const waitMode = (mode) =>
    page.waitForSelector(
      `[data-testid="${TID_SIDE_PANE_FULL_VIEW_HOST}"][data-side-pane-full-view-host="${mode}"]`,
      { state: "attached" },
    );
  const peek = () => page.evaluate(() => window.appShellFixture.peekFullView());
  const waitForFixture = async (predicate, label) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await page.evaluate(predicate)) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`fixture state timeout: ${label}`);
  };

  // App 启动后普通视图；快捷键先打开面板再进入完整视图。
  assert.equal(await hostMode(), "normal");
  const splitEntryEnabled = () => page.getByTestId("app-shell-split-entry-enabled").textContent();
  assert.equal(await splitEntryEnabled(), "true", "普通视图允许新建分屏");
  await page.keyboard.press("Control+Shift+KeyF");
  await waitMode("floating");
  assert.equal(
    await splitEntryEnabled(),
    "false",
    "完整视图生效期间同一个 split entry 派生值为 false",
  );
  assert.equal(
    await page.getByTestId("workspace-header").count(),
    0,
    "完整视图隐藏 WorkspaceHeader",
  );
  assert.deepEqual(await peek(), { surface: "side-pane", floating: "collapsed" });

  // 关闭面板：App 立即清除当前 owner 的完整视图记录，不靠延时或重挂载。
  await page.getByTestId(TID_SIDE_PANE_TOGGLE).click();
  await waitMode("normal");
  await waitForFixture(
    () => window.appShellFixture.peekFullView() === null,
    "owner record cleared",
  );
  assert.equal(await page.getByTestId("workspace-header").count(), 1, "退出后恢复 WorkspaceHeader");
  assert.equal(await splitEntryEnabled(), "true", "退出完整视图后分屏入口恢复");

  // 面板关闭时按快捷键：先落记录再开面板；多 pane 时入口显式禁用并退出。
  await page.keyboard.press("Control+Shift+KeyF");
  await waitMode("floating");
  await page.evaluate(() => window.appShellFixture.splitPane());
  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-shell-pane-count"]')?.textContent === "2",
  );
  await waitMode("normal");
  assert.equal(
    await page.getByTestId(TID_SIDE_PANE_FULL_VIEW_TOGGLE).isDisabled(),
    true,
    "多 pane 时完整视图入口禁用",
  );
  assert.equal(await splitEntryEnabled(), "true", "多 pane 本身不关闭分屏入口");
  await page.evaluate(() => window.appShellFixture.resetPanes());
  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-shell-pane-count"]')?.textContent === "1",
  );
  await waitMode("floating");
  assert.equal(
    await page.getByTestId(TID_SIDE_PANE_FULL_VIEW_TOGGLE).isDisabled(),
    false,
    "回到单 pane 后入口恢复",
  );
  assert.equal(await splitEntryEnabled(), "false", "重新进入完整视图后分屏入口再次关闭");
  await page.keyboard.press("Control+Shift+KeyF");
  await waitMode("normal");
  assert.equal(await splitEntryEnabled(), "true", "最终退出后保持正常分屏入口");

  assert.deepEqual(errors, [], `页面不应有运行时错误：${errors.join(" | ")}`);
  assert.deepEqual(external, [], `不应有外部网络请求：${external.join(", ")}`);
  console.log(
    "App shell full view guard passed: real App/WorkspaceShellLayout enters full view, closes with the pane, clears the owner record, and disables the entry while the conversation is split.",
  );
} finally {
  await browser?.close();
  server.close();
}
