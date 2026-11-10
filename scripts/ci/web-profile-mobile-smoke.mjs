import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  DRAWER_SELECTOR,
  MOBILE_SHELL_SELECTOR,
  SIDEBAR_SELECTOR,
  SIDEBAR_WIDTH_KEY,
  SIDE_FRAME_SELECTOR,
  SIDE_PANE_CLOSE_SELECTOR,
  SIDE_PANE_PANEL_SELECTOR,
  SIDE_PANE_RESIZE_HANDLE_SELECTOR,
  WORKSPACE_HEADER_SELECTOR,
  accessibleName,
  assertComposerDraft,
  assertComposerFontSize,
  assertContentFullWidth,
  assertNoOverflow,
  desktopBodyLayoutEntries,
  focusInside,
  frameVisible,
  isSidebarVisibleInPage,
  openMobileDrawer,
  readElementBox,
  readStableWorkspaceBodyLayoutStorage,
  readWorkspaceBodyLayoutRatios,
  sidebarPanelWidth,
  visibleCount,
  waitElementFullWidth,
  waitVisibleCount,
} from "./web-profile-mobile-page.mjs";
import {
  buildFixtureScript,
  buildFreshUiCss,
  makeTempDirs,
  readWebEntry,
} from "./web-profile-mobile-fixture.mjs";

// 现有 Web profile 手机适配回归（spec：.agents/specs/web-profile-mobile.md）。
// 真实 packages/web/index.html -> 同一 App/WorkspaceShellLayout；手机用例挂载真实
// AnimatedSidePanePanel（外层 panel + 内层 data-workspace-side-frame）与真实 WorkspaceHeader，
// 只把重型业务叶子换成 fixture。输入区仍挂生产 LexicalChatInput 观察 16px/草稿/不重挂载。
const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");
const SIDEBAR_WIDTH_PX = 300;
const COMPOSER_DRAFT_TEXT = "resize draft";
const HEADER_HEIGHT_PX = 48;

let dirs;
let server;
let context;
try {
  // 临时目录与构建都在 try 内：构建失败也必须回收 profile/home/tmp，不能只清理成功路径。
  await mkdir(cacheDir, { recursive: true });
  dirs = await makeTempDirs(cacheDir);
  const fixtureScript = await buildFixtureScript(root, cacheDir);
  const css = await buildFreshUiCss(root, dirs.tempDir);
  const { raw: rawIndexHtml, html: indexHtml } = await readWebEntry(root);
  assert.match(
    rawIndexHtml,
    /data-zcode-entry\s*=\s*["']web["']/u,
    "packages/web/index.html must declare data-zcode-entry=web on the real Web HTML entry",
  );
  // 窄 Electron 窗口没有 Web entry 标记：同一个真实入口去掉标记后仅用于测试桌面窄窗语义。
  const electronIndexHtml = indexHtml.replace(' data-zcode-entry="web"', "");
  assert.notEqual(
    electronIndexHtml,
    indexHtml,
    "Web entry marker was not removable for Electron fixture",
  );
  const logo = await readFile(resolve(root, "public/logo/icons/512x512.png"));

  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/public/logo/icons/512x512.png") {
      response.setHeader("Content-Type", "image/png");
      response.end(logo);
      return;
    }
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
    if (pathname === "/electron.html") {
      response.setHeader("Content-Type", "text/html");
      response.end(electronIndexHtml);
      return;
    }
    if (pathname.startsWith("/assets/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(indexHtml);
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
  const external = [];
  context.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    return route.abort();
  });
  await context.addInitScript((key) => localStorage.setItem(key, "300"), SIDEBAR_WIDTH_KEY);
  // launchPersistentContext 自带一个初始空白页；不关掉时测试页是后台标签页，
  // rAF 被节流会让 Playwright 的 visible/stable/焦点断言随机超时。
  for (const initialPage of context.pages()) await initialPage.close();

  const page = await context.newPage();
  await page.bringToFront();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`${origin}/?surface=web`);
  await page.getByTestId("app-shell-chat-area").waitFor();

  const composer = page.getByTestId("v4-composer-input");
  await composer.waitFor();
  const assertComposerDraftPreserved = (label) =>
    assertComposerDraft(page, COMPOSER_DRAFT_TEXT, label);
  const isMobileShell = async () => (await page.locator(MOBILE_SHELL_SELECTOR).count()) > 0;
  const drawerVisible = async () => (await visibleCount(page, DRAWER_SELECTOR)) > 0;
  const waitDrawer = (expected) => waitVisibleCount(page, DRAWER_SELECTOR, expected ? 1 : 0);
  const waitFrame = (expected) => waitVisibleCount(page, SIDE_FRAME_SELECTOR, expected ? 1 : 0);
  const sidebarVisible = () => page.evaluate(isSidebarVisibleInPage);
  // 1280 桌面 Web 基线：不是手机布局，保留 side pane 收起 + 已存侧栏宽度。
  // 同时记录桌面 body layout 的 localStorage 与真实面板比例，手机回来后逐项对比。
  assert.equal(await isMobileShell(), false, "desktop Web must not expose mobile shell");
  assert.equal(await sidebarVisible(), true, "desktop Web keeps the sidebar visible");
  assert.equal(await drawerVisible(), false, "desktop Web must not render the mobile drawer");
  assert.equal(await sidebarPanelWidth(page), SIDEBAR_WIDTH_PX, "stored sidebar width is applied");
  await assertComposerFontSize(page, 14, "1280x860 desktop baseline");
  await assertNoOverflow(page, "1280x860 desktop baseline");
  const desktopLayoutBefore = desktopBodyLayoutEntries(
    await readStableWorkspaceBodyLayoutStorage(page),
  );
  const desktopRatiosBefore = await readWorkspaceBodyLayoutRatios(page);
  assert.ok(desktopRatiosBefore, "desktop body layout ratios must be readable before mobile");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(MOBILE_SHELL_SELECTOR).waitFor();

  // 390x844：真实 draft WorkspaceHeader 占住顶部 48px，抽屉收起、内容全宽。
  const mobileHeader = page.locator(WORKSPACE_HEADER_SELECTOR);
  await mobileHeader.waitFor();
  const headerBox = await mobileHeader.boundingBox();
  assert.ok(headerBox, "mobile draft WorkspaceHeader has no box");
  assert.equal(
    await mobileHeader.getAttribute("data-workspace-header-variant"),
    "draft",
    "mobile header must be the real draft variant",
  );
  assert.ok(
    headerBox.y <= 1 && Math.abs(headerBox.height - HEADER_HEIGHT_PX) <= 1,
    `mobile header must reserve the top ${HEADER_HEIGHT_PX}px: ${JSON.stringify(headerBox)}`,
  );
  assert.equal(await sidebarVisible(), false, "mobile entry starts with the sidebar closed");
  assert.equal(await drawerVisible(), false, "mobile entry starts with the drawer closed");
  await assertNoOverflow(page, "390x844 initial");
  await assertContentFullWidth(page, "390x844 initial");
  await assertComposerFontSize(page, 16, "390x844");
  await assertNoOverflow(page, "390x844 after header");
  // 在真实编辑器里输入后，后续软键盘式 resize / 旋转 / 回宽屏都不能丢草稿或重挂载。
  await composer.evaluate((element) => {
    element.dataset.e2eEditorMount = "1";
  });
  await composer.click();
  await page.keyboard.type(COMPOSER_DRAFT_TEXT);
  await assertComposerDraftPreserved("390x844 after typing");

  await openMobileDrawer(page);
  // 只认 WorkspaceSidebarDrawer 的真实 testid；drawer 内复用同一个 sidebar 实例。
  assert.equal(await page.locator(SIDEBAR_SELECTOR).count(), 1, "drawer reuses the single sidebar");
  assert.equal(await sidebarVisible(), true, "drawer exposes the sidebar");
  assert.equal(await focusInside(page, DRAWER_SELECTOR), true, "drawer moves focus inside");
  assert.ok(await accessibleName(page, DRAWER_SELECTOR), "drawer has an accessible name");
  await assertNoOverflow(page, "390x844 drawer open");
  const viewport390 = page.viewportSize();
  await page.mouse.click(viewport390.width - 3, 120);
  await waitDrawer(false);
  await openMobileDrawer(page);
  await page.keyboard.press("Escape");
  await waitDrawer(false);

  // 选择任务 / 新建后，抽屉由同一 App 开合 owner 收起。夹具没有真实 task/session 投影，
  // 选择路径带不存在 remote identity 后由 shell fail-closed；本用例只声明「意图收起抽屉」。
  await openMobileDrawer(page);
  await page.getByTestId("fixture-select-task").click({ noWaitAfter: true });
  await waitDrawer(false);
  assert.equal(await page.evaluate(() => window.appShellFixture.selectedTaskId), "fixture-task");
  await openMobileDrawer(page);
  await page.getByTestId("fixture-create-task").click({ noWaitAfter: true });
  await waitDrawer(false);
  assert.equal(await page.evaluate(() => window.appShellFixture.newTaskCount), 1);

  // 右侧文件预览：真实面板的外层 Panel 与内层 frame 分开断言，frame 必须全宽覆盖；
  // 手机覆盖层不提供拖拽调整宽度，关闭仍走面板内真实 side-pane toggle。
  await openMobileDrawer(page);
  await page.getByTestId("fixture-open-preview").click({ noWaitAfter: true });
  await waitDrawer(false);
  await waitFrame(true);
  const viewportFrame = page.viewportSize();
  // 真实面板展开时先锁 200ms 宽度再解锁；等内层 frame 真正铺满，而不是拿锁宽瞬间当全宽。
  await waitElementFullWidth(page, SIDE_FRAME_SELECTOR, viewportFrame.width).catch(() => {});
  const panelBox = await readElementBox(page, SIDE_PANE_PANEL_SELECTOR);
  const frameBox = await readElementBox(page, SIDE_FRAME_SELECTOR);
  assert.ok(panelBox, "mobile side pane outer panel is missing");
  assert.ok(frameBox, "mobile side pane inner frame is missing");
  assert.ok(
    frameBox.x <= 1 && frameBox.width >= viewportFrame.width - 2,
    `mobile side pane frame must cover the viewport width: ${JSON.stringify({ frameBox, viewportFrame })}`,
  );
  assert.ok(
    Math.abs(frameBox.y - (headerBox.y + headerBox.height)) <= 2,
    `mobile side pane must start below the header, not cover it: ${JSON.stringify({ frameBox, headerBox })}`,
  );
  assert.equal(
    await visibleCount(page, SIDE_PANE_RESIZE_HANDLE_SELECTOR),
    0,
    "mobile full-width preview must not expose a resize handle",
  );
  await assertNoOverflow(page, "390x844 side pane open");
  await page.locator(SIDE_PANE_CLOSE_SELECTOR).click({ noWaitAfter: true });
  await waitFrame(false);

  // 320x640：更窄仍无溢出；旋转/软键盘式 resize 不触发桌面自动收面板策略。
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator(MOBILE_SHELL_SELECTOR).waitFor();
  assert.equal(await sidebarVisible(), false, "320x640 starts with sidebar closed");
  await assertNoOverflow(page, "320x640 initial");
  await assertContentFullWidth(page, "320x640 initial");
  await assertComposerFontSize(page, 16, "320x640");
  await assertComposerDraftPreserved("320x640 resize");
  await openMobileDrawer(page);
  await page.setViewportSize({ width: 320, height: 420 });
  await page.waitForTimeout(400);
  assert.equal(await drawerVisible(), true, "keyboard-height resize must not close the drawer");
  await assertComposerDraftPreserved("320x420 keyboard-height resize");
  await page.setViewportSize({ width: 390, height: 420 });
  await page.waitForTimeout(400);
  assert.equal(await drawerVisible(), true, "mobile-width resize must not close the drawer");
  await assertComposerDraftPreserved("390x420 resize");
  await page.keyboard.press("Escape");
  await waitDrawer(false);
  await openMobileDrawer(page);
  await page.getByTestId("fixture-open-preview").click({ noWaitAfter: true });
  await waitFrame(true);
  await page.setViewportSize({ width: 320, height: 420 });
  await page.waitForTimeout(400);
  assert.equal(await frameVisible(page), true, "resize must not close the mobile side pane");
  assert.equal(
    await visibleCount(page, SIDE_PANE_RESIZE_HANDLE_SELECTOR),
    0,
    "resized mobile preview must still not expose a resize handle",
  );
  await page.setViewportSize({ width: 390, height: 420 });
  await page.waitForTimeout(400);
  assert.equal(await frameVisible(page), true, "width resize must not close the mobile side pane");
  await assertComposerDraftPreserved("390x420 resize with side pane open");
  await page.locator(SIDE_PANE_CLOSE_SELECTOR).click({ noWaitAfter: true });
  await waitFrame(false);

  // 回到宽屏：恢复进入手机前的侧栏可见性；桌面 body-layout key 与面板比例保持原值。
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForFunction(
    (selector) => document.querySelector(selector) === null,
    MOBILE_SHELL_SELECTOR,
  );
  await page.waitForFunction(isSidebarVisibleInPage);
  assert.equal(await drawerVisible(), false, "wide viewport must not keep the mobile drawer");
  assert.equal(
    await sidebarPanelWidth(page),
    SIDEBAR_WIDTH_PX,
    "mobile must preserve stored sidebar width",
  );
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), SIDEBAR_WIDTH_KEY),
    String(SIDEBAR_WIDTH_PX),
    "mobile interaction must not rewrite the stored sidebar width",
  );
  assert.deepEqual(
    desktopBodyLayoutEntries(await readStableWorkspaceBodyLayoutStorage(page)),
    desktopLayoutBefore,
    "mobile must not rewrite the desktop workspace-body-layout storage",
  );
  const desktopRatiosAfter = await readWorkspaceBodyLayoutRatios(page);
  assert.ok(desktopRatiosAfter, "desktop body layout ratios must be readable after mobile");
  for (const key of ["conversation", "sidePane"]) {
    assert.ok(
      Math.abs(desktopRatiosBefore[key] - desktopRatiosAfter[key]) <= 0.01,
      `mobile must not change desktop ${key} ratio: ${JSON.stringify({ desktopRatiosBefore, desktopRatiosAfter })}`,
    );
  }
  await assertNoOverflow(page, "1280x860 restored desktop");
  await assertComposerFontSize(page, 14, "1280x860 restored desktop");
  await assertComposerDraftPreserved("1280x860 restored desktop");

  // ConversationComposer 的自动聚焦接线（startDraft/draftFocusVersion →
  // resolveComposerAutoFocus）不在本浏览器夹具内重复：真实 Composer 挂载时 Lexical
  // selectEnd 会原生聚焦，浏览器镜头只能证明夹具编辑器状态；由主线补充真实 Composer
  // 的定向源码 + 决策测试，避免这里继续用纯函数探针冒充 wiring。

  // 手机宽度下直接重载入口（而非仅从宽屏切入）：新的 App 仍默认收起抽屉。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/?surface=web`);
  await page.locator(MOBILE_SHELL_SELECTOR).waitFor();
  await page.getByTestId("app-shell-chat-area").waitFor();
  assert.equal(await sidebarVisible(), false, "cold mobile entry starts with sidebar closed");
  assert.equal(await drawerVisible(), false, "cold mobile entry starts with drawer closed");
  await assertContentFullWidth(page, "cold mobile entry");
  await assertNoOverflow(page, "cold mobile entry");

  // 窄 Electron 窗口没有 Web entry 标记：仍是原桌面布局，不进入手机抽屉语义。
  // 额外页面放在最后再开，避免后台标签页的 rAF 节流干扰前面的焦点/稳定性断言。
  const electronPage = await context.newPage();
  await electronPage.bringToFront();
  electronPage.on("pageerror", (error) => errors.push(error.message));
  await electronPage.setViewportSize({ width: 390, height: 844 });
  await electronPage.goto(`${origin}/electron.html?surface=electron`);
  await electronPage.getByTestId("app-shell-chat-area").waitFor();
  assert.equal(
    await electronPage.locator(MOBILE_SHELL_SELECTOR).count(),
    0,
    "narrow Electron-like fixture must stay desktop",
  );
  assert.equal(
    await visibleCount(electronPage, DRAWER_SELECTOR),
    0,
    "narrow Electron-like fixture has no mobile drawer",
  );
  assert.equal(
    await electronPage.evaluate(isSidebarVisibleInPage),
    true,
    "narrow Electron-like fixture keeps the desktop sidebar",
  );

  assert.deepEqual(errors, [], `pages must not emit runtime errors: ${errors.join(" | ")}`);
  assert.deepEqual(external, [], `test must not request external network: ${external.join(", ")}`);
  console.log(
    "PASS web profile mobile: real packages/web/index.html + App/shell at 390/320/1280/narrow-Electron-like; real draft header reserves top 48px, real side pane panel/frame full-width overlay below header with no resize handle and real close button; drawer/Escape/select/new close; desktop workspace-body-layout storage+ratios unchanged after mobile; real Lexical composer 16px mobile/14px desktop, typed draft survives resizes without remount; narrow Electron-like stays desktop.",
  );
  console.log("Rerun: node scripts/ci/web-profile-mobile-smoke.mjs");
} finally {
  // 先关浏览器再关 server，最后回收构建产出的临时目录；任一步失败都不影响后续清理。
  await context?.close();
  server?.close();
  if (dirs) await rm(dirs.tempDir, { recursive: true, force: true });
}
