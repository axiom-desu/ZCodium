// 数据同步 UI 的真实浏览器守卫（临时 profile/HOME/XDG、loopback 页面，外部网络全部拦截）。
// 覆盖：真实 DataSyncDialog 的概览/比较/默认勾选、最小化与恢复、CAS 冲突→再次同步→写入、
// 远端独有条目保留、旧 Server 缺方法的 typed unsupported、Provider lane 失败→重试→成功与密钥掩码、
// 设备离线禁用操作。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { buildFreshUiCss, makeTempDirs, readWebEntry } from "./web-profile-mobile-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");

function assetUrlPlugin() {
  return {
    name: "zcode-test-asset-url",
    setup(build) {
      build.onResolve({ filter: /\?url$/ }, (args) => ({
        path: args.path,
        namespace: "zcode-test-asset-url",
      }));
      build.onLoad({ filter: /.*/, namespace: "zcode-test-asset-url" }, () => ({
        contents: 'export default "data:text/plain,zcode-test-asset-url"',
        loader: "js",
      }));
    },
  };
}

async function buildFixtureScript() {
  const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
  const output = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, "packages/ui/test/fixtures/data-sync-ui.jsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    outdir: resolve(cacheDir, "data-sync-ui-fixture"),
    alias: { "@": resolve(root, "packages/ui/src") },
    plugins: [assetUrlPlugin()],
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".wasm": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.PROD": "true",
      "import.meta.env.DEV": "false",
      "import.meta.env.MODE": '"production"',
    },
  });
  const script = output.outputFiles.find((file) => file.path.endsWith(".js"))?.contents;
  if (!script?.length) throw new Error("data-sync UI fixture was not built");
  return script;
}

let dirs;
let server;
let context;
try {
  await mkdir(cacheDir, { recursive: true });
  dirs = await makeTempDirs(cacheDir);
  const fixtureScript = await buildFixtureScript();
  const css = await buildFreshUiCss(root, dirs.tempDir);
  const { html } = await readWebEntry(root);

  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(fixtureScript);
      return;
    }
    if (pathname === "/styles.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
      return;
    }
    if (pathname.startsWith("/assets/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  context = await chromium.launchPersistentContext(dirs.profileDir, {
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
  const errors = [];
  context.on("request", (request) => {
    const hostname = new URL(request.url()).hostname;
    if (hostname !== "127.0.0.1") errors.push(`external request: ${request.url()}`);
  });
  await context.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  for (const initialPage of context.pages()) await initialPage.close();

  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(origin);

  // 1. 分类比较 / 默认勾选 / 远端独有项不展示
  await page.locator('[data-testid="data-sync-dialog"]').waitFor();
  await page.locator('[data-testid="data-sync-row-alpha"][data-sync-status="push"]').waitFor();
  await page.locator('[data-testid="data-sync-row-beta"][data-sync-status="synced"]').waitFor();
  await page
    .locator('[data-testid="data-sync-row-gamma"][data-sync-status="difference"]')
    .waitFor();
  assert.equal(await page.locator('[data-testid="data-sync-row-delta"]').count(), 0);
  assert.equal(
    await page.getAttribute('[data-testid="data-sync-row-alpha"]', "aria-checked"),
    "true",
  );
  assert.equal(
    await page.getAttribute('[data-testid="data-sync-row-gamma"]', "aria-checked"),
    "false",
  );

  // 2. 旧 Server 缺方法：typed unsupported，不是空列表成功
  await page.click('[data-testid="data-sync-tab-skills"]');
  await page.locator('[data-testid="data-sync-unsupported"]').waitFor();
  assert.equal(
    await page.getAttribute('[data-testid="data-sync-unsupported"]', "data-unsupported-reason"),
    "agent-method-missing",
  );
  assert.equal(await page.locator('[data-testid="data-sync-row-alpha"]').count(), 0);
  assert.equal(
    await page.getByText("Nothing to sync in this category.").count(),
    0,
    "unsupported must not look like an empty category",
  );
  assert.ok(
    await page.isDisabled('[data-testid="data-sync-push"]'),
    "unsupported category cannot push",
  );

  // 3. CAS 冲突 → 再次同步 → 写入；父级/远端独有项不被删除
  await page.click('[data-testid="data-sync-tab-mcp"]');
  await page.locator('[data-testid="data-sync-row-gamma"]').waitFor();
  await page.click('[data-testid="data-sync-row-gamma"]');
  assert.equal(
    await page.getAttribute('[data-testid="data-sync-row-gamma"]', "aria-checked"),
    "true",
  );
  await page.evaluate(() => window.dataSyncFixture.mutateRemote("gamma", "G2"));
  await page.click('[data-testid="data-sync-push"]');
  await page.locator('[data-testid="data-sync-row-error-gamma"]').waitFor();
  assert.match(
    await page.textContent('[data-testid="data-sync-row-error-gamma"]'),
    /Remote content changed/u,
  );
  await page.waitForFunction(() => window.dataSyncFixture.getPushResults()[0] === "partial");
  const firstWrites = await page.evaluate(() => window.dataSyncFixture.getWrites());
  assert.deepEqual(
    firstWrites.map((write) => write.key),
    ["alpha"],
    "conflicted item is not written",
  );
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-testid="data-sync-row-gamma"]');
    return row?.getAttribute("data-sync-status") === "difference";
  });
  await page.waitForFunction(() => {
    const push = document.querySelector('[data-testid="data-sync-push"]');
    return push && !push.disabled;
  });
  await page.click('[data-testid="data-sync-push"]');
  await page.waitForFunction(() => window.dataSyncFixture.getPushResults()[1] === "success");
  const writes = await page.evaluate(() => window.dataSyncFixture.getWrites());
  assert.ok(
    writes.some(
      (write) => write.key === "gamma" && write.mode === "overwrite" && write.value === "G1",
    ),
    "resync writes the overwritten item",
  );
  const remote = await page.evaluate(() => window.dataSyncFixture.getRemote());
  assert.equal(remote.delta, "D1", "remote-only item is preserved");
  await page.locator('[data-testid="data-sync-row-gamma"][data-sync-status="synced"]').waitFor();

  // 4. 最小化 → 状态条 → 恢复（推送 owner 不卸载）
  await page.click('[data-testid="data-sync-minimize"]');
  await page.locator('[data-testid="data-sync-minimized"]').waitFor();
  await page.locator('[data-testid="data-sync-dialog"]').waitFor({ state: "detached" });
  await page.click('[data-testid="data-sync-minimized"]');
  await page.locator('[data-testid="data-sync-dialog"]').waitFor();

  // 5. Provider lane 失败 → 重试 → 成功；密钥只显示掩码
  await page.click('[data-testid="data-sync-tab-providers"]');
  await page
    .locator('[data-testid="data-sync-providers-status"][data-provisioning-state="failed"]')
    .waitFor();
  const keyText = await page.textContent('[data-testid="data-sync-provider-key-openai"]');
  assert.match(keyText, /••••abcd/u);
  assert.ok(!keyText.includes("sk-test-1234567890abcd"), "plaintext API key is not rendered");
  assert.match(await page.textContent('[data-testid="data-sync-providers-status"]'), /failed/u);
  await page.click('[data-testid="data-sync-providers-retry"]');
  await page
    .locator('[data-testid="data-sync-providers-status"][data-provisioning-state="success"]')
    .waitFor();
  assert.equal(await page.locator('[data-testid="data-sync-providers-retry"]').count(), 0);

  // 6. 设备离线：显示离线提示，推送/重试禁用，弹窗保持打开
  await page.evaluate(() => window.dataSyncFixture.setOnline(false));
  await page.locator('[data-testid="data-sync-offline"]').waitFor();
  await page.click('[data-testid="data-sync-tab-mcp"]');
  await page.waitForFunction(() => {
    const push = document.querySelector('[data-testid="data-sync-push"]');
    return push && push.disabled;
  });
  assert.equal(await page.locator('[data-testid="data-sync-dialog"]').count(), 1);

  assert.deepEqual(errors, []);
  console.log(
    "[data-sync-ui] PASS compare/conflict/resync/write/minimize/unsupported/providers/offline",
  );
} finally {
  await context?.close().catch(() => {});
  if (server) {
    server.close();
    await once(server, "close").catch(() => {});
  }
}
