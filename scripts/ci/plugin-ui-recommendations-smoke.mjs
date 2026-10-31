// Production PluginUiLauncherItems + PluginStorePage in isolated Chromium over loopback.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
// 复用 packages/services 已声明的 esbuild，不把构建工具提升成新的根依赖。
const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
const { outputFiles } = await build({
  entryPoints: [resolve(root, "packages/ui/test/fixtures/plugin-ui-recommendations.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "empty" },
  outdir: resolve(tmpdir(), "zcodium-plugin-ui-browser"),
  define: { "process.env.NODE_ENV": '"production"' },
});
const assets =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const cssName = (await readdir(assets)).find((name) => /^styles-.*\.css$/.test(name));
assert.ok(cssName, "Build desktop CSS before plugin UI browser checks");
const css = await readFile(resolve(assets, cssName));
const script = outputFiles.find((file) => file.path.endsWith(".js")).contents;
const server = createServer(async (request, response) => {
  if (/\.(?:woff2?|ttf)$/.test(request.url)) {
    try {
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(await readFile(resolve(assets, basename(request.url))));
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  if (request.url === "/style.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
    return;
  }
  response.setHeader(
    "Content-Type",
    request.url === "/fixture.js" ? "text/javascript" : "text/html",
  );
  response.end(
    request.url === "/fixture.js"
      ? script
      : '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><style>html,body,#root {height:auto;overflow:visible} body {background:var(--color-background)!important} #root {padding:12px;max-width:760px;margin:auto}</style><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/fixture.js"></script>',
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
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(`http://127.0.0.1:${server.address().port}/?locale=en-US`);

  const launcherItem = page.locator(
    '[data-side-pane-open-tab-item="plugin-ui:documents@zcode-plugins-official/documents"]',
  );
  // A's list is held; B resolves after switching. Duplicate surfaceId must not render twice.
  await page.getByTestId("switch-workspace").click();
  await launcherItem.getByText("B Docs").waitFor();
  assert.equal(await launcherItem.count(), 1);
  await page.getByTestId("release-late-a").click();
  await page.waitForTimeout(300);
  assert.equal(await launcherItem.count(), 1);
  assert.equal(await launcherItem.getByText("B Docs").count(), 1);
  assert.equal(await launcherItem.getByText("A Docs").count(), 0);

  // Clicking B resolves B's surface, not A's late response.
  await launcherItem.click();
  await page.waitForFunction(() => window.marketplaceFixture.opened.length === 1);
  assert.equal(await page.evaluate(() => window.marketplaceFixture.opened[0].title), "B Docs");

  // Store detail is keyed by workspace: switching back must never show the released A snapshot.
  await page
    .locator('[data-testid="plugin-store-card"][data-plugin-id="documents@zcode-plugins-official"]')
    .waitFor();
  await page
    .locator('[data-testid="plugin-store-card"][data-plugin-id="documents@zcode-plugins-official"]')
    .click();
  await page.getByTestId("plugin-store-detail").waitFor();
  await page.getByTestId("plugin-store-description").getByText("B workspace documents").waitFor();
  await page.getByTestId("plugin-store-open-ui").waitFor();
  await page.getByTestId("plugin-store-ui-capability").getByText("B Docs").waitFor();
  await page.getByTestId("switch-workspace").click();
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId("plugin-store-description").count(), 0);
  // 无公开推荐配置时回退到真实目录里的 UI 插件，而不是永远空态。
  await page.goto(`http://127.0.0.1:${server.address().port}/?locale=en-US&fallback=1`);
  await page.getByTestId("switch-workspace").click();
  await launcherItem.getByText("B Docs").waitFor();
  assert.equal(await launcherItem.count(), 1);

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "PASS production plugin UI recommendations: duplicate surface dedupe, A/B late response isolation, B surface open, local catalog fallback, no external requests",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
