import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { buildFreshUiCss, makeTempDirs, readWebEntry } from "./web-profile-mobile-fixture.mjs";

// U4 真实 Chromium 守卫（fixture packages/ui/test/fixtures/upstream-318-project-remote-ui.jsx）：
// - 项目管理：复核/筛选/批量移除/撤销/测容彻底删除/失败重试；真实 ProjectManagement + 内存项目服务；
// - 远端设备：真实 SourceProfileList + 内存管理服务；运行任务清单、停止/重启、取消更新、旧版本禁用、
//   显式降级确认。
// 临时 HOME/XDG/Chromium profile + loopback，外部网络全部拦截。

const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");
const PROJECT_PATH = "/#projects";
const SOURCE_PATH = "/#source";

async function buildFixtureScript() {
  const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
  const output = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, "packages/ui/test/fixtures/upstream-318-project-remote-ui.jsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    outdir: resolve(cacheDir, "sync318-u4-fixture"),
    alias: { "@": resolve(root, "packages/ui/src") },
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".wasm": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.PROD": "true",
      "import.meta.env.DEV": "false",
      "import.meta.env.MODE": '"production"',
    },
  });
  const script = output.outputFiles.find((file) => file.path.endsWith(".js"))?.contents;
  if (!script?.length) throw new Error("U4 fixture was not built");
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

  const openPage = async (path) => {
    const page = await context.newPage();
    // 失败重试用例会走真实 logger.error；生产门禁的 sanitized 日志不是页面错误。
    await page.addInitScript(() => {
      globalThis.__ZCODE_RENDERER_DISABLE_LOGGING__ = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${origin}${path}`);
    return page;
  };

  // 1. 项目管理：复核 → 批量移除 → 撤销 → 测容彻底删除 → 失败重试
  {
    const page = await openPage(PROJECT_PATH);
    await page.locator('[data-testid="project-management"]').waitFor();
    await page.locator('[data-testid="project-management-suggestion"]').waitFor();

    // 远程项目只读：勾选框禁用。
    const remoteRow = page.locator('[data-testid="project-management-row"]', {
      hasText: "Remote",
    });
    assert.equal(
      await remoteRow.locator('[data-testid="project-management-row-checkbox"]').isDisabled(),
      true,
    );

    await page.locator('[data-testid="project-management-review"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="project-management-row"]').length === 3,
    );
    await page.locator('[data-testid="project-management-remove"]').click();
    await page.locator('[data-testid="project-management-confirm-remove"]').click();
    await page.waitForFunction(() => window.projectFixture.deleted.length === 3);
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => window.projectFixture.restored.length === 3);

    // 单个项目同时删除 ZCode 数据：测量 → 确认词 → deleteProjectData。
    const alphaRow = page.locator('[data-testid="project-management-row"]', { hasText: "Alpha" });
    await alphaRow.locator('[data-testid="project-management-row-checkbox"]').click();
    await page.locator('[data-testid="project-management-remove"]').click();
    const confirm = page.locator('[data-testid="project-management-confirm"]');
    await confirm.waitFor();
    await page
      .locator('[data-testid="project-management-confirm-data"] [data-slot="checkbox"]')
      .click();
    await page.locator('[data-testid="project-management-confirm-data-word"]').fill("delete");
    await page.locator('[data-testid="project-management-confirm-remove"]').click();
    await page.waitForFunction(() => window.projectFixture.purged.includes("alpha"));
    assert.ok((await page.evaluate(() => window.projectFixture.measured.flat())).includes("alpha"));

    // 失败重试：适配器故意失败一次，横幅出现后重试成功。
    await page.evaluate(() => {
      window.projectFixture.failPurge = true;
    });
    const betaRow = page.locator('[data-testid="project-management-row"]', { hasText: "Beta" });
    await betaRow.locator('[data-testid="project-management-row-checkbox"]').click();
    await page.locator('[data-testid="project-management-remove"]').click();
    await page
      .locator('[data-testid="project-management-confirm-data"] [data-slot="checkbox"]')
      .click();
    await page.locator('[data-testid="project-management-confirm-data-word"]').fill("delete");
    await page.locator('[data-testid="project-management-confirm-remove"]').click();
    await page.locator('[data-testid="project-management-failure"]').waitFor();
    await page.locator('[data-testid="project-management-retry"]').click();
    await page.waitForFunction(() => window.projectFixture.purged.includes("beta"));
    await page.locator('[data-testid="project-management-failure"]').waitFor({ state: "detached" });

    // 390 宽无横向溢出（#92 手机设置布局回归）。
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `mobile overflow ${overflow}`);
    await page.close();
  }

  // 2. 远端设备生命周期
  {
    const page = await openPage(SOURCE_PATH);
    await page.locator('[data-testid="source-profile-list"]').waitFor();

    const online = page.locator("li", { hasText: "Online" });
    await online.getByRole("button", { name: "More actions for Online" }).click();
    await page.locator('[data-testid="source-lifecycle-restart"]').click();
    await page.locator('[data-testid="source-confirm"]').waitFor();
    const description = await page
      .locator('[data-testid="source-confirm-description"]')
      .innerText();
    assert.match(description, /task-1 — \/work\/one/u);
    await page.locator('[data-testid="source-confirm-ok"]').click();
    await page.waitForFunction(() =>
      window.sourceFixture.calls.some(([kind, id]) => kind === "restart" && id === "s1"),
    );

    const old = page.locator("li", { hasText: "Old" });
    await old.getByText("Update first").waitFor();
    await old.getByRole("button", { name: "More actions for Old" }).click();
    assert.equal(await page.locator('[data-testid="source-lifecycle-restart"]').isDisabled(), true);
    await page.keyboard.press("Escape");

    const updating = page.locator("li", { hasText: "Updating" });
    await updating.getByRole("button", { name: "More actions for Updating" }).click();
    await page.locator('[data-testid="source-lifecycle-cancel-update"]').click();
    await page.waitForFunction(() =>
      window.sourceFixture.calls.some(([kind, id]) => kind === "cancel" && id === "p3"),
    );

    const newer = page.locator("li", { hasText: "Newer" });
    await newer.getByRole("button", { name: "More actions for Newer" }).click();
    await page.locator('[data-testid="source-lifecycle-downgrade"]').click();
    await page.locator('[data-testid="source-confirm"]').waitFor();
    const downgrade = await page.locator('[data-testid="source-confirm-title"]').innerText();
    assert.match(downgrade, /3\.19\.0/u);
    await page.locator('[data-testid="source-confirm-ok"]').click();
    await page.waitForFunction(() =>
      window.sourceFixture.calls.some(
        ([kind, input]) => kind === "update" && input?.allowDowngrade === true,
      ),
    );
    await page.close();
  }

  assert.deepEqual(errors, []);
  console.log("[sync318-u4] PASS project-management/source-lifecycle");
} finally {
  await context?.close().catch(() => {});
  if (server) {
    server.close();
    await once(server, "close").catch(() => {});
  }
  if (dirs) await rm(dirs.tempDir, { recursive: true, force: true }).catch(() => {});
}
