import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { makeTempDirs } from "./web-profile-mobile-fixture.mjs";

// 扩展授权（sessions.read / sessions.write）的真实 Chromium 交互守卫：
// 生产展示组件显示每个声明档位的人话说明，点击 Enable 提交的恰好是当前声明档位。
// 临时 profile/HOME/XDG + loopback 页面，外部网络全部拦截；只读已安装的浏览器缓存。
const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");

async function buildFixtureScript() {
  const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
  const output = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, "packages/ui/test/fixtures/extension-sessions-consent.jsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    outdir: resolve(cacheDir, "extension-sessions-consent"),
    alias: { "@": resolve(root, "packages/ui/src") },
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.PROD": "true",
      "import.meta.env.DEV": "false",
      "import.meta.env.MODE": '"production"',
    },
  });
  const script = output.outputFiles.find((file) => file.path.endsWith(".js"))?.contents;
  if (!script?.length) throw new Error("extension consent fixture was not built");
  return script;
}

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Extension consent</title></head>
<body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;

await mkdir(cacheDir, { recursive: true });
const dirs = await makeTempDirs(cacheDir);
const fixtureScript = await buildFixtureScript();
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(fixtureScript);
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(HTML);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

const errors = [];
const context = await chromium.launchPersistentContext(dirs.profileDir, {
  headless: true,
  executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  viewport: { width: 1280, height: 860 },
  env: {
    ...process.env,
    HOME: dirs.homeDir,
    XDG_CONFIG_HOME: dirs.xdgConfigDir,
    XDG_CACHE_HOME: dirs.xdgCacheDir,
    TMPDIR: dirs.tempDir,
  },
  args: ["--no-proxy-server", "--disable-background-networking"],
});
context.on("request", (request) => {
  if (new URL(request.url()).hostname !== "127.0.0.1")
    errors.push(`external request: ${request.url()}`);
});
await context.route("**/*", (route) =>
  new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
);

try {
  for (const initialPage of context.pages()) await initialPage.close();
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(origin);
  await page.locator('[data-testid="extension-status-slot"]').waitFor();
  await page.locator('[data-testid="extension-consent-grants"]').waitFor();

  const descriptions = await page
    .locator('[data-testid="extension-consent-grants"] li')
    .allTextContents();
  assert.equal(descriptions.length, 2, "one line per declared grant");
  assert.match(descriptions[0], /Read the project list/u);
  assert.match(descriptions[1], /Read and change conversations/u);
  assert.match(descriptions[1], /Includes session read access/u);
  assert.match(
    await page.locator('[data-testid="extension-consent-notice"]').innerText(),
    /not provide OS-level isolation/u,
    "consent keeps the no-OS-sandbox boundary",
  );

  await page.getByRole("button", { name: "Enable" }).click();
  await page.waitForFunction(() => window.consentFixture.requests.length === 1);
  const requests = await page.evaluate(() => window.consentFixture.requests);
  assert.deepEqual(requests, [
    { pluginId: "demo-sessions", grants: ["projects.read", "sessions.write"] },
  ]);
  assert.deepEqual(errors, [], "no page errors or external requests");

  // 移动端宽度下授权说明仍然可见、可点击。
  await page.setViewportSize({ width: 390, height: 780 });
  await page.locator('[data-testid="extension-consent-grants"]').waitFor();
  assert.ok(await page.getByRole("button", { name: "Enable" }).isVisible());
  await page.close();
  console.log("extension sessions consent: ok (desktop + mobile viewport)");
} finally {
  await context.close();
  server.close();
  await rm(dirs.tempDir, { recursive: true, force: true });
}
