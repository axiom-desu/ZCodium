import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright-core";
import { createFileManagerPage } from "./fixtures/file-manager-page.mjs";

// 文件管理器导航面板浏览器 E2E（spec：.agents/specs/file-manager-navigation-pane.md）。
// 夹具加载生产 FileManagerPane / PreviewPane / WorkspaceFileTree；workspace 是临时目录，
// FileService 通过 loopback 适配器读取，不接触真实用户数据，也不允许任何外部请求。
const root = resolve(import.meta.dirname, "../..");
const NAV_TOGGLE = '[data-testid="file-manager-navigation-toggle"]';
const TREE_PANEL = '[data-testid="workspace-file-tree-panel"]';
const PREVIEW_PANE = '[data-testid="preview-pane"]';
const HEADER = "[data-file-manager-header]";
const PREF_KEY = "zcode-file-manager-navigation-preferences";

const tempRoot = await mkdtemp(join(tmpdir(), "zcode-file-manager-e2e-"));
const workspaceA = join(tempRoot, "workspace-a");
const workspaceB = join(tempRoot, "workspace-b");
const workspaceC = join(tempRoot, "workspace-c");
await mkdir(join(workspaceA, "src"), { recursive: true });
await mkdir(workspaceB, { recursive: true });
await mkdir(workspaceC, { recursive: true });
await writeFile(join(workspaceA, "alpha.md"), "# alpha preview body\n");
await writeFile(join(workspaceA, "src", "nested.md"), "nested body\n");
await writeFile(join(workspaceB, "beta.md"), "beta preview body\n");
await writeFile(join(workspaceC, "gamma.md"), "gamma preview body\n");

function assertInsideTempRoot(targetPath) {
  const normalized = resolve(targetPath);
  if (normalized !== tempRoot && !normalized.startsWith(`${tempRoot}/`)) {
    throw new Error("path outside fixture workspace");
  }
  return normalized;
}

async function readDirectoryEntries(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      path: join(directoryPath, entry.name),
      type: entry.isDirectory() ? "directory" : "file",
      isSymbolicLink: entry.isSymbolicLink(),
    }))
    .sort((left, right) =>
      left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type === "directory"
          ? -1
          : 1,
    );
}

const outputs = await build({
  configFile: false,
  logLevel: "error",
  root,
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(root, "packages/ui/test/fixtures/file-manager-pane.jsx"),
      output: { format: "es", codeSplitting: false },
    },
  },
});
const built = (Array.isArray(outputs) ? outputs : [outputs])
  .flatMap((output) => output.output)
  .find((chunk) => chunk.type === "chunk");
assert.ok(built?.code, "File manager fixture bundle was not produced");
const assets =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const styleName = (await readdir(assets)).find((entry) => /^styles-.*\.css$/.test(entry));
assert.ok(styleName, "Build the desktop renderer before running the file manager test");
const css = await readFile(resolve(assets, styleName), "utf8");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/fixture.js" || url.pathname === "/style.css") {
      res.setHeader(
        "Content-Type",
        url.pathname === "/fixture.js" ? "text/javascript" : "text/css",
      );
      res.end(url.pathname === "/fixture.js" ? built.code : css);
      return;
    }
    if (url.pathname === "/fs/readdir") {
      const directoryPath = assertInsideTempRoot(url.searchParams.get("path") ?? "");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(await readDirectoryEntries(directoryPath)));
      return;
    }
    if (url.pathname === "/fs/read") {
      const filePath = assertInsideTempRoot(url.searchParams.get("path") ?? "");
      const content = await readFile(filePath, "utf8");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          path: filePath,
          content,
          offset: 0,
          bytesRead: Buffer.byteLength(content),
          totalBytes: Buffer.byteLength(content),
          truncated: false,
          isBinary: false,
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="/fixture.js"></script>',
    );
  } catch (error) {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.message : String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

let browser;
let page;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  // 全新 browser 上下文自带干净 origin 存储；不能 addInitScript(clear)，否则 reload 恢复断言会清掉偏好。
  page = await browser.newPage();
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

  const visit = async (query) => {
    await page.goto(`${baseUrl}?${query}`);
    await page.locator(TREE_PANEL).waitFor();
  };
  const rowSelector = (workspacePath, ...segments) =>
    `[data-testid="workspace-file-tree-row-${[workspacePath, ...segments].join("/")}"]`;
  const waitRow = (workspacePath, ...segments) =>
    page.locator(rowSelector(workspacePath, ...segments)).waitFor();
  const rowCount = (workspacePath, ...segments) =>
    page.locator(rowSelector(workspacePath, ...segments)).count();
  const treeWidth = () =>
    page.locator(TREE_PANEL).evaluate((element) => element.getBoundingClientRect().width);
  const previewWidth = () =>
    page.locator(PREVIEW_PANE).evaluate((element) => element.getBoundingClientRect().width);
  const navExpanded = async () =>
    (await page.locator(NAV_TOGGLE).getAttribute("aria-expanded")) === "true";
  const waitNav = (expanded) =>
    page.waitForFunction(
      ({ selector, expanded }) =>
        document.querySelector(selector)?.getAttribute("aria-expanded") === String(expanded),
      { selector: NAV_TOGGLE, expanded },
    );
  const { readPrefs, setDelay, setTarget, waitFor } = createFileManagerPage(page, PREF_KEY);

  // ------------------------------------------------------------------ 默认展开 + 真实临时目录 + 文件预览
  await visit(`workspace=${encodeURIComponent(workspaceA)}&locale=en-US&theme=light`);
  await waitRow(workspaceA, "alpha.md");
  await waitRow(workspaceA, "src");
  assert.equal(await navExpanded(), true, "默认展开目录导航");
  assert.match(
    await page.locator(`${HEADER} span`).first().innerText(),
    /^Files$/,
    "无文件时 header 显示文件标题",
  );
  assert.match(
    await page.locator("[data-file-manager-pane]").innerText(),
    /Select a file from the navigation/,
  );
  const openTreeWidth = await treeWidth();
  assert.ok(openTreeWidth > 150, `目录栏默认可见，实际 ${openTreeWidth}`);

  await page.locator(rowSelector(workspaceA, "alpha.md")).click();
  await page.locator(`${PREVIEW_PANE} >> text=alpha preview body`).waitFor();
  await waitFor(() => window.fileManagerFixture.navigateCount === 1, "navigate once");
  assert.equal(
    await page.evaluate(() => window.fileManagerFixture.sourcePath),
    join(workspaceA, "alpha.md"),
    "目录行导航携带真实文件路径",
  );
  assert.match(
    await page.locator(HEADER).innerText(),
    /alpha\.md/,
    "预览面包屑渲染在文件管理器 header 容器",
  );

  // refresh 走同一 FileService 读盘：改变临时目录后点刷新，目录行必须更新。
  await writeFile(join(workspaceA, "refresh-target.md"), "refresh body\n");
  await page.locator('[data-testid="workspace-file-tree-refresh-button"]').click();
  await waitRow(workspaceA, "refresh-target.md");

  // ------------------------------------------------------------------ 收起/展开：用布局状态而非 hidden，且偏好落盘
  const previewOpenWidth = await previewWidth();
  await page.locator(NAV_TOGGLE).click();
  await waitNav(false);
  await page.waitForFunction(
    ({ selector }) => document.querySelector(selector)?.getBoundingClientRect().width === 0,
    { selector: TREE_PANEL },
  );
  assert.ok((await previewWidth()) > previewOpenWidth, "收起目录后预览变宽（无外层占位）");
  assert.deepEqual(await readPrefs(), { [workspaceA]: false }, "显隐偏好按 workspace 落盘");

  await page.locator(NAV_TOGGLE).click();
  await waitNav(true);
  await page.waitForFunction(
    ({ selector, min }) =>
      (document.querySelector(selector)?.getBoundingClientRect().width ?? 0) >= min,
    { selector: TREE_PANEL, min: 150 },
  );
  assert.deepEqual(await readPrefs(), { [workspaceA]: true }, "再次展开恢复目录宽度");

  // ------------------------------------------------------------------ 偏好按 workspace 隔离 + 刷新恢复
  await setTarget({ workspacePath: workspaceB });
  await waitRow(workspaceB, "beta.md");
  assert.equal(await navExpanded(), true, "新 workspace 不受其它 workspace 偏好影响");
  assert.equal(await rowCount(workspaceA, "alpha.md"), 0, "切换 workspace 后不残留旧目录");
  await page.locator(NAV_TOGGLE).click();
  await waitNav(false);
  assert.deepEqual(
    await readPrefs(),
    { [workspaceA]: true, [workspaceB]: false },
    "两个 workspace 各自保存",
  );

  await setTarget({ workspacePath: workspaceA });
  await waitRow(workspaceA, "alpha.md");
  assert.equal(await navExpanded(), true, "回到 workspace A 恢复其展开偏好");

  await setTarget({ workspacePath: workspaceB });
  await waitRow(workspaceB, "beta.md");
  assert.equal(await navExpanded(), false, "回到 workspace B 恢复其收起偏好");

  await page.goto(
    `${baseUrl}?workspace=${encodeURIComponent(workspaceB)}&locale=en-US&theme=light`,
  );
  await waitRow(workspaceB, "beta.md");
  assert.equal(await navExpanded(), false, "刷新后恢复持久化偏好");

  // ------------------------------------------------------------------ 同路径不同远端 identity 不串偏好
  await setTarget({
    workspacePath: workspaceA,
    workspaceIdentity: "remote-x",
    workspaceRemoteSessionId: "fixture-remote-x",
  });
  await waitRow(workspaceA, "alpha.md");
  assert.equal(await navExpanded(), true, "新远端 identity 默认展开");
  await page.locator(NAV_TOGGLE).click();
  await waitNav(false);
  const prefsAfterRemoteX = await readPrefs();
  assert.equal(prefsAfterRemoteX["remote-x"], false, "偏好 key 使用 identity");

  await setTarget({
    workspacePath: workspaceA,
    workspaceIdentity: "remote-y",
    workspaceRemoteSessionId: "fixture-remote-y",
  });
  await waitRow(workspaceA, "alpha.md");
  assert.equal(await navExpanded(), true, "同路径不同远端不共享偏好");
  await setTarget({
    workspacePath: workspaceA,
    workspaceIdentity: "remote-x",
    workspaceRemoteSessionId: "fixture-remote-x",
  });
  await waitRow(workspaceA, "alpha.md");
  assert.equal(await navExpanded(), false, "切回远端 x 恢复其偏好");

  // ------------------------------------------------------------------ 切 workspace 后旧目录迟到响应不覆盖
  await setTarget({ workspacePath: workspaceC });
  await waitRow(workspaceC, "gamma.md");
  await setDelay(workspaceA, 900);
  await setTarget({ workspacePath: workspaceA });
  await page.waitForTimeout(120);
  await setTarget({ workspacePath: workspaceC });
  await waitRow(workspaceC, "gamma.md");
  await page.waitForTimeout(1200);
  assert.equal(await rowCount(workspaceA, "alpha.md"), 0, "迟到的旧 workspace 目录不覆盖新目录");
  assert.equal(await rowCount(workspaceC, "gamma.md"), 1, "新目录保持");
  assert.match(
    await page.locator(`${TREE_PANEL} h3`).first().innerText(),
    /workspace-c/,
    "目录标题仍指向新 workspace",
  );
  await setDelay(workspaceA, 0);

  // ------------------------------------------------------------------ 窄布局选中文件自动收起且不写偏好
  await setTarget({ workspacePath: workspaceC });
  await waitRow(workspaceC, "gamma.md");
  await page.evaluate(() => window.fileManagerFixture.setNarrow(true));
  await page.waitForFunction(
    ({ selector }) => (document.querySelector(selector)?.getBoundingClientRect().width ?? 0) <= 360,
    { selector: TREE_PANEL },
  );
  assert.equal(await navExpanded(), true, "窄布局先显示目录");
  await page.locator(rowSelector(workspaceC, "gamma.md")).click();
  await waitNav(false);
  await page.locator(`${PREVIEW_PANE} >> text=gamma preview body`).waitFor();
  const prefsAfterNarrow = await readPrefs();
  assert.equal(
    Object.prototype.hasOwnProperty.call(prefsAfterNarrow, workspaceC),
    false,
    "窄布局自动收起不写偏好",
  );
  await page.evaluate(() => window.fileManagerFixture.setNarrow(false));
  await waitNav(true);

  // ------------------------------------------------------------------ 生产面板集成：code-viewer tab 内嵌文件管理器，目录行不新建 tab
  await page.goto(
    `${baseUrl}?mode=panel&workspace=${encodeURIComponent(workspaceA)}&locale=en-US&theme=light`,
  );
  await page.locator("[data-file-manager-pane]").waitFor();
  await waitRow(workspaceA, "alpha.md");
  await page.locator(`${PREVIEW_PANE} >> text=alpha preview body`).waitFor();
  assert.equal(
    await page.locator("[data-side-pane-tab-id]").count(),
    1,
    "面板只有一个 code-viewer tab",
  );
  const tabIdBefore = await page
    .locator("[data-side-pane-tab-id]")
    .first()
    .getAttribute("data-side-pane-tab-id");
  await page.locator(rowSelector(workspaceA, "src")).click();
  await waitRow(workspaceA, "src", "nested.md");
  await page.locator(rowSelector(workspaceA, "src", "nested.md")).click();
  await page.locator(`${PREVIEW_PANE} >> text=nested body`).waitFor();
  assert.equal(
    await page.evaluate(() => window.fileManagerFixture.panelNavigateCount),
    1,
    "面板目录行导航走生产 navigateCodeViewerSidePane",
  );
  assert.equal(await page.locator("[data-side-pane-tab-id]").count(), 1, "目录行导航不新建 tab");
  assert.equal(
    await page.locator("[data-side-pane-tab-id]").first().getAttribute("data-side-pane-tab-id"),
    tabIdBefore,
    "导航保留原 tab 身份",
  );

  // ------------------------------------------------------------------ 中文 / 暗色
  await page.goto(`${baseUrl}?workspace=${encodeURIComponent(workspaceA)}&locale=zh-CN&theme=dark`);
  await waitRow(workspaceA, "alpha.md");
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    true,
    "暗色主题生效",
  );
  assert.equal(await page.locator(NAV_TOGGLE).getAttribute("aria-label"), "收起文件导航");
  assert.match(await page.locator("[data-file-manager-pane]").innerText(), /从目录中选择一个文件/);

  assert.deepEqual(errors, [], `页面不应有运行时错误：${errors.join(" | ")}`);
  assert.deepEqual(external, [], `不应有外部网络请求：${external.join(", ")}`);
  console.log(
    "File manager navigation walkthrough passed: real temp workspace, default-open directory, preview + breadcrumb, collapse/expand via layout state with per-workspace persisted preference, workspace/remote-identity isolation, reload restore, stale directory response dropped, compact auto-collapse without persisting, code-viewer tab inside the production side pane navigates without a new tab, zh/en + light/dark, no external requests.",
  );
} finally {
  await browser?.close();
  server.close();
  await rm(tempRoot, { recursive: true, force: true });
}
