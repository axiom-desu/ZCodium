import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

// 分屏新建守卫的组件 E2E（spec：docs/specs/side-pane-full-view.md「多 pane」）。
// 真实组件：V4WorkspaceChatArea、V4SplitPaneEntryContext、paneLayoutStore、
// workbenchSessionPlacement、useSidePaneFullView；只替换 SessionPane 展示叶子。
const root = resolve(import.meta.dirname, "../..");
const fixtureDir = resolve(root, "packages/ui/test/fixtures");
const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
const leaves = resolve(fixtureDir, "workbench-split-guard-leaves.jsx");
const outputs = await build({
  absWorkingDir: root,
  entryPoints: [resolve(fixtureDir, "workbench-split-guard.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: {
    "@/v4/SessionPane.js": leaves,
    "@/v4/V4ConversationContext.js": leaves,
    "@": resolve(root, "packages/ui/src"),
  },
  outdir: resolve(root, "node_modules/.cache/workbench-split-guard"),
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.PROD": "true",
    "import.meta.env.DEV": "false",
  },
});
const built = outputs.outputFiles.find((file) => file.path.endsWith(".js"));
assert.ok(built?.contents, "Workbench split guard fixture bundle was not produced");
const script = built.contents;
const assetDir =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const styleName = (await readdir(assetDir)).find((name) => /^styles-.*\.css$/.test(name));
assert.ok(styleName, "Build the desktop renderer before running the split guard");
const css = await readFile(resolve(assetDir, styleName), "utf8");

const server = createServer((request, response) => {
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
  await page.getByTestId("guard-session-pane").first().waitFor();

  const text = (testId) => page.getByTestId(testId).textContent();
  const paneCount = () => text("guard-pane-count");
  const enabled = () => text("guard-split-enabled");
  const fullView = () => text("guard-full-view");
  const waitForText = (testId, value) =>
    page.waitForFunction(
      ({ testId, value }) =>
        document.querySelector(`[data-testid="${testId}"]`)?.textContent === value,
      { testId, value },
    );

  // 拖拽载荷跨多次 evaluate 保留，模拟“拖拽已开始/已 offer”后再进入完整视图。
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData(
      "application/x-zcode-session",
      JSON.stringify({
        kind: "zcode/session",
        workspacePath: "/fixture/workbench-split-guard",
        sessionId: "task-b",
      }),
    );
    window.__guardDragTransfer = transfer;
  });
  const fireDrag = (type) =>
    page.evaluate((eventType) => {
      const pane = document.querySelector('[data-testid="v4-pane-shell-workspace-main"]');
      const rect = pane.getBoundingClientRect();
      const event = new DragEvent(eventType, {
        bubbles: true,
        cancelable: true,
        clientX: rect.right - 8,
        clientY: rect.top + rect.height / 2,
        dataTransfer: window.__guardDragTransfer,
      });
      pane.dispatchEvent(event);
      return event.defaultPrevented;
    }, type);

  // 1) 普通单 pane：pane 头分屏入口与拖拽落边都可用。
  assert.equal(await paneCount(), "1");
  assert.equal(await enabled(), "true");
  assert.equal(await fullView(), "false");
  assert.equal(
    await page.getByTestId("guard-split-right").count(),
    1,
    "普通视图显示 pane 头分屏入口",
  );
  assert.equal(await fireDrag("dragover"), true, "普通视图接受拖拽 offer");
  assert.equal(await fireDrag("drop"), true, "普通视图接受 drop 提交");
  await waitForText("guard-pane-count", "2");
  assert.equal(await page.getByTestId("guard-split-right").count(), 2, "分屏后两个 pane 都有入口");

  await page.getByTestId("guard-reset-panes").click();
  await waitForText("guard-pane-count", "1");

  // 2) 进入完整视图：唯一派生值关闭，所有入口拒绝，且不改变分屏布局。
  await page.getByTestId("guard-enter-full-view").click();
  await waitForText("guard-full-view", "true");
  assert.equal(await enabled(), "false", "完整视图生效期间分屏入口派生值为 false");
  assert.equal(await page.getByTestId("guard-split-right").count(), 0, "pane 头分屏入口消失");
  assert.equal(await fireDrag("dragover"), false, "完整视图拒绝拖拽 offer");
  assert.equal(await fireDrag("drop"), false, "完整视图拒绝 drop 提交");
  assert.equal(await paneCount(), "1", "被拒绝的 drop 不改变分屏布局");

  // 3) 拖拽中途进入完整视图：已发生的 offer 在提交时重验并拒绝。
  await page.getByTestId("guard-exit-full-view").click();
  await waitForText("guard-full-view", "false");
  assert.equal(await enabled(), "true");
  assert.equal(await fireDrag("dragover"), true, "进入完整视图前 offer 已被接受");
  await page.getByTestId("guard-enter-full-view").click();
  await waitForText("guard-full-view", "true");
  assert.equal(await fireDrag("dragover"), false, "进入完整视图后 offer 立即撤回");
  assert.equal(await fireDrag("drop"), false, "进入完整视图后 drop 提交被拒绝");
  assert.equal(await paneCount(), "1", "中途进入完整视图不产生新分屏");

  // 4) 退出完整视图后恢复正常多 pane 行为。
  await page.getByTestId("guard-exit-full-view").click();
  await waitForText("guard-full-view", "false");
  assert.equal(await enabled(), "true");
  assert.equal(await fireDrag("dragover"), true);
  assert.equal(await fireDrag("drop"), true);
  await waitForText("guard-pane-count", "2");

  assert.deepEqual(errors, [], `页面不应有运行时错误：${errors.join(" | ")}`);
  assert.deepEqual(external, [], `不应有外部网络请求：${external.join(", ")}`);
  console.log(
    "Workbench split guard passed: normalized single/multi-pane splits still work, the derived full-view availability disables pane-header/drag-offer/drop entry points, and a drop committed after entering full view mid-drag is rejected without changing the layout.",
  );
} finally {
  await browser?.close();
  server.close();
}
