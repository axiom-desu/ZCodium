import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/conversation-import.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  outdir: resolve(tmpdir(), "zcodium-import-browser-fixture"),
  loader: { ".css": "empty", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = outputFiles.find((file) => file.path.endsWith(".js")).contents;
let css = "";
// CI 可只跑行为检查；本地人工视觉走查使用真实桌面构建的样式。
if (process.env.ZCODE_TEST_RENDERER_ASSETS) {
  const directory = process.env.ZCODE_TEST_RENDERER_ASSETS;
  const file = (await readdir(directory)).find((name) => /^styles-.*\.css$/.test(name));
  assert.ok(file, "Desktop production CSS must exist for visual walkthrough");
  css = await readFile(resolve(directory, file), "utf8");
}
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
  // busy 由 React 在 file input 清理后的一次提交中解除（见 useConversationArchiveImport.ts
  // 的 finally / cancel 分支），input 从 DOM 移除是同步的、早于该提交。
  // 因此等待 UI 可观察状态（菜单按钮 enabled），而不是把 input 移除当作解锁信号；
  // waitForFunction 保留默认超时，避免回归时无限等待。
  const waitForMenuEnabled = (label) =>
    page.waitForFunction((name) => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === name,
      );
      return Boolean(button && !button.disabled);
    }, label);
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    requests.push(route.request().url());
    return route.abort();
  });

  for (const locale of ["zh-CN", "en-US"]) {
    const menuName = locale === "zh-CN" ? "对话选项" : "Conversation options";
    const actionName = locale === "zh-CN" ? "从文件导入…" : "Import from file…";
    const retryName = locale === "zh-CN" ? "重试" : "Retry";
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      for (const outcome of ["success", "failure", "corrupt", "unavailable"]) {
        await page.goto(
          `http://127.0.0.1:${server.address().port}/?locale=${locale}&outcome=${outcome}&theme=${width === 1280 ? "dark" : "light"}`,
        );
        if (outcome === "unavailable") {
          await page.waitForTimeout(100);
          assert.equal(await page.getByRole("button", { name: menuName }).count(), 0);
          continue;
        }
        const menu = page.getByRole("button", { name: menuName });
        await menu.waitFor();
        // Both actions are genuine keyboard controls; cancel leaves no busy state or transfer.
        await menu.focus();
        await page.keyboard.press("Enter");
        await page.getByRole("menuitem", { name: actionName }).waitFor();
        if (process.env.ZCODE_TEST_SCREENSHOT_DIR) {
          await page.waitForTimeout(300);
          await page.screenshot({
            path: resolve(
              process.env.ZCODE_TEST_SCREENSHOT_DIR,
              `import-menu-${locale}-${width}.png`,
            ),
          });
        }
        const firstPicker = page.waitForEvent("filechooser");
        await page.getByRole("menuitem", { name: actionName }).press("Enter");
        await firstPicker;
        await page
          .locator('input[type="file"]')
          .evaluate((element) => element.dispatchEvent(new Event("cancel")));
        await page.waitForFunction(() => !document.querySelector('input[type="file"]'));
        assert.equal((await page.evaluate(() => window.importCalls)).begins, 0);
        await waitForMenuEnabled(menuName);
        const selectFile = async () => {
          await menu.click();
          const chooser = page.waitForEvent("filechooser");
          await page.getByRole("menuitem", { name: actionName }).click();
          await (
            await chooser
          ).setFiles({
            name: "conversation.zcodium",
            mimeType: "application/octet-stream",
            buffer: Buffer.from([80, 75, 0, 255, 42]),
          });
        };
        await selectFile();
        await page.waitForFunction(() => window.importCalls.releases === 1);
        if (outcome === "corrupt") {
          assert.equal(await page.getByRole("button", { name: retryName, exact: true }).count(), 0);
          assert.equal((await page.evaluate(() => window.importCalls)).opens.length, 0);
          continue;
        }
        if (outcome === "failure") {
          const retry = page.getByRole("button", { name: retryName, exact: true });
          await retry.waitFor();
          if (process.env.ZCODE_TEST_SCREENSHOT_DIR) {
            await page.waitForTimeout(300);
            await page.screenshot({
              path: resolve(
                process.env.ZCODE_TEST_SCREENSHOT_DIR,
                `import-retry-${locale}-${width}.png`,
              ),
            });
          }
          await retry.click();
        }
        await page
          .getByRole("status")
          .filter({
            hasText: locale === "zh-CN" ? "已打开导入的会话" : "Imported conversation opened",
          })
          .waitFor();
        await selectFile();
        await page.waitForFunction(
          (count) => window.importCalls.releases === count,
          outcome === "failure" ? 3 : 2,
        );
        const calls = await page.evaluate(() => window.importCalls);
        assert.equal(calls.opens.length, 2);
        assert.equal(calls.begins, calls.imports);
        assert.deepEqual(calls.bytes, [80, 75, 0, 255, 42]);
        assert.equal(calls.target.targetWorkspacePath, "/fixture/workspace");
        assert.equal(await page.locator('input[type="file"]').count(), 0);
      }
    }
  }

  // A disconnected Host can finish late; its completion must neither open a tab nor unlock the new operation.
  await page.goto(`http://127.0.0.1:${server.address().port}/?locale=en-US&outcome=switch`);
  const switchMenu = page.getByRole("button", { name: "Conversation options" });
  const startPending = async () => {
    await switchMenu.click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Import from file…" }).click();
    await (
      await chooser
    ).setFiles({
      name: "conversation.zcodium",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([80, 75, 42]),
    });
  };
  await startPending();
  await page.waitForFunction(() => window.pendingImportResolvers.length === 1);
  await page.evaluate(() => window.replaceImportHost());
  await startPending();
  await page.waitForFunction(() => window.pendingImportResolvers.length === 2);
  await page.getByText("Creating the conversation…", { exact: true }).waitFor();
  await page.evaluate(() => window.pendingImportResolvers[0]());
  await page.waitForFunction(() => window.importCalls.releases === 1);
  assert.equal(await switchMenu.isDisabled(), true);
  assert.equal((await page.evaluate(() => window.importCalls)).opens.length, 0);
  await page.evaluate(() => window.pendingImportResolvers[1]());
  await page.waitForFunction(() => window.importCalls.opens.length === 1);
  await waitForMenuEnabled("Conversation options");
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    "Conversation import walkthrough passed: keyboard, picker cancel, success, retry, duplicate, corrupt file, capability gating, stale Host completion; zh/en narrow/wide; no external requests.",
  );
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
