import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { buildFreshUiCss, makeTempDirs, readWebEntry } from "./web-profile-mobile-fixture.mjs";
import { buildComposerFocusFixtureScript } from "./composer-mobile-focus-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");
const mention = "[@fixture.ts](/fixture/workspace/fixture.ts)";
const viewports = { mobile: { width: 390, height: 844 }, wide: { width: 1280, height: 860 } };
let server, context, dirs;
const runtimeErrors = [];
try {
  await mkdir(cacheDir, { recursive: true });
  dirs = await makeTempDirs(cacheDir);
  const fixture = await buildComposerFocusFixtureScript(
    root,
    cacheDir,
    "packages/ui/test/fixtures/conversation-composer-input-prediction.jsx",
  );
  const css = await buildFreshUiCss(root, dirs.tempDir);
  const { html } = await readWebEntry(root);
  server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = requestUrl.pathname;
    if (path === "/fixture.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(fixture);
    } else if (path === "/styles.css") {
      res.setHeader("content-type", "text/css");
      res.end(css);
    } else if (path.startsWith("/assets/")) {
      res.writeHead(404).end();
    } else {
      res.setHeader("content-type", "text/html");
      res.end(
        requestUrl.searchParams.get("surface") === "desktop"
          ? html.replace('data-zcode-entry="web"', 'data-zcode-entry="desktop"')
          : html,
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context = await chromium.launchPersistentContext(dirs.profileDir, {
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    viewport: viewports.mobile,
    env: {
      ...process.env,
      HOME: dirs.homeDir,
      XDG_CONFIG_HOME: dirs.xdgConfigDir,
      XDG_CACHE_HOME: dirs.xdgCacheDir,
      TMPDIR: dirs.tempDir,
    },
    args: ["--no-proxy-server", "--disable-background-networking"],
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  for (const page of context.pages()) await page.close();
  async function pageAt(viewport, desktopProfile = false) {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(10000);
    const pageErrors = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
      runtimeErrors.push(error.stack ?? error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    await page.setViewportSize(viewport);
    // HTML入口本身决定profile；initScript在documentElement存在前运行，不能用它伪造标记。
    await page.goto(`${origin}/?surface=${desktopProfile ? "desktop" : "web"}`);
    try {
      await page.getByTestId("composer-prediction-harness").waitFor({ timeout: 10000 });
    } catch (error) {
      throw new Error(`composer fixture failed: ${pageErrors.join(" | ")}`, { cause: error });
    }
    await page.locator('[data-testid="v4-composer-input"]').waitFor();
    return page;
  }
  const calls = (page) => page.evaluate(() => window.composerPredictionFixture.calls.length);
  const waitCall = (page, expected = 1) =>
    page.waitForFunction(
      (count) => window.composerPredictionFixture.calls.length === count,
      expected,
      { timeout: 5000 },
    );

  for (const viewport of [viewports.wide]) {
    const page = await pageAt(viewport);
    await page.waitForTimeout(900);
    assert.equal(await calls(page), 0, "wide Web must not issue prediction requests");
    await page.close();
  }
  const desktop = await pageAt(viewports.mobile, true);
  await desktop.waitForTimeout(900);
  assert.equal(await calls(desktop), 0, "Desktop profile must not issue prediction requests");
  await desktop.close();

  const mobile = await pageAt(viewports.mobile);
  await waitCall(mobile);
  await mobile.evaluate(() => window.composerPredictionFixture.respond());
  const hint = mobile.getByTestId("composer-input-prediction");
  await hint.waitFor();
  assert.equal(
    await mobile.evaluate(() => document.activeElement?.getAttribute("data-testid")),
    null,
    "show must not autofocus",
  );
  await hint.evaluate((button) => button.click());
  await mobile.waitForTimeout(500);
  assert.equal(
    await mobile.evaluate(() => window.composerPredictionFixture.readText()),
    `${mention} completion`,
    `accepted Lexical text mismatch`,
  );
  const editorJson = await mobile
    .locator('[data-testid="v4-composer-input"]')
    .evaluate((el) => el.__zcodeLexicalInputE2E.getEditorState().toJSON());
  assert.ok(
    JSON.stringify(editorJson).includes("prompt-mention"),
    "accept must preserve the structured Lexical mention node",
  );
  assert.equal(
    await mobile.evaluate(() => window.composerPredictionFixture.sends),
    0,
    "accept must not auto-send",
  );
  assert.equal(await hint.count(), 0, "accepted hint should be removed");
  await mobile.close();

  // Every stale-result boundary is exercised against the production hook and real Lexical editor.
  for (const boundary of ["edit", "stop", "submit", "dispose"]) {
    const page = await pageAt(viewports.mobile);
    await waitCall(page);
    if (boundary === "edit") {
      await page
        .locator('[data-testid="v4-composer-input"]')
        .evaluate((el) => el.__zcodeLexicalInputE2E.setText("new draft"));
    } else if (boundary === "stop") {
      await page.evaluate(() => window.composerPredictionFixture.remount({ active: false }));
      await page.locator('[data-testid="v4-composer-input"]').waitFor();
    } else if (boundary === "submit") {
      // 已恢复的真实结构化 mention 本身就是可发送草稿；直接点生产发送按钮，
      // 不用额外键盘动作把「提交边界」混成焦点/输入法测试。
      await page.getByTestId("v4-composer-send").evaluate((button) => button.click());
      await page.waitForFunction(() => window.composerPredictionFixture.sends > 0);
    } else {
      await page.evaluate(() => window.composerPredictionFixture.remount());
      await page.locator('[data-testid="v4-composer-input"]').waitFor();
    }
    await page.waitForFunction(() => window.composerPredictionFixture.cancels.length > 0);
    await page.evaluate(() => window.composerPredictionFixture.respond());
    await page.waitForTimeout(250);
    assert.equal(
      await page.getByTestId("composer-input-prediction").count(),
      0,
      `${boundary} must reject a late result`,
    );
    if (boundary !== "submit")
      assert.equal(
        await page.evaluate(() => window.composerPredictionFixture.sends),
        0,
        `${boundary} must not auto-send`,
      );
    await page.close();
  }
  assert.deepEqual(runtimeErrors, [], "prediction fixture must have no runtime errors");
  console.log(
    "input prediction composer smoke: passed (narrow show/accept, structured mention, exclusions, stale boundaries)",
  );
} finally {
  await context?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
