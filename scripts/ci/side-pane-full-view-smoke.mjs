import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright-core";

// Side Pane 完整视图隔离浏览器 E2E（spec：docs/specs/side-pane-full-view.md）。
// 夹具 (packages/ui/test/fixtures/side-pane-full-view.jsx) 加载生产组件（宿主/状态 owner/内存/面板/快捷键/输入框），
// 样式来自实际 desktop 构建产物；只连 loopback，不读真实用户数据、不装浏览器。
const root = resolve(import.meta.dirname, "../..");
const TID = {
  toggle: "side-pane-full-view-toggle",
  conversationTab: "side-pane-full-view-conversation-tab",
  host: "side-pane-full-view-host",
  header: "side-pane-full-view-floating-header",
  expand: "side-pane-full-view-floating-expand",
  running: "side-pane-full-view-floating-running",
  answerBubble: "side-pane-full-view-answer-bubble",
  answerBubbleClose: "side-pane-full-view-answer-bubble-close",
  minimize: "side-pane-full-view-floating-minimize",
  handle: "side-pane-full-view-floating-handle",
  bubble: "side-pane-full-view-floating-bubble",
  sidePaneToggle: "side-pane-toggle",
};
const RESIZE_HANDLE = '[data-workspace-side-pane-resize-handle="true"]';
const HOST_SELECTOR = `[data-testid="${TID.host}"]`;

// 用 vite 打包夹具：root 已声明 vite（构建工具链），无需为测试脚本新增 esbuild 依赖；
// wasm / worker 资源在白色白板 tab 下不会被加载，只随构建产物输出、不在本测试里取用。
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
      input: resolve(root, "packages/ui/test/fixtures/side-pane-full-view.jsx"),
      output: { format: "es", codeSplitting: false },
    },
  },
});
const built = (Array.isArray(outputs) ? outputs : [outputs])
  .flatMap((output) => output.output)
  .find((chunk) => chunk.type === "chunk");
assert.ok(built?.code, "Side pane full view fixture bundle was not produced");
// 浮窗与 tab 栏依赖正式样式；CI 与本地必须使用同一 desktop 构建产物。
const assets =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const styleName = (await readdir(assets)).find((entry) => /^styles-.*\.css$/.test(entry));
assert.ok(styleName, "Build the desktop renderer before running the side pane full view test");
const css = await readFile(resolve(assets, styleName), "utf8");
// 浮窗几何依赖随本特性新增的 Tailwind 工具类；旧构建产物会让断言以“布局不对”失败，
// 这里直接指出需要重建 desktop renderer（与 CI 的 build:no-runtime-assets 顺序一致）。
assert.match(
  css,
  /--side-pane-full-view-clip-height/,
  "Rebuild the desktop renderer: styles-*.css is missing the side pane full view utilities",
);
const server = createServer((req, res) => {
  if (req.url === "/fixture.js" || req.url === "/style.css") {
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/css");
    res.end(req.url === "/fixture.js" ? built.code : css);
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
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

  const visit = async (query) => {
    await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
    await page.getByTestId(TID.host).waitFor();
  };
  const rect = (scope) =>
    scope.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    });
  const rectOf = (testId) => rect(page.getByTestId(testId));
  const slotRect = () => rect(page.locator('[data-side-pane-content-slot=""]'));
  const hostMode = () => page.getByTestId(TID.host).getAttribute("data-side-pane-full-view-host");
  const waitMode = (mode) =>
    page.waitForSelector(`${HOST_SELECTOR}[data-side-pane-full-view-host="${mode}"]`);
  const waitFloating = (floating) =>
    page.waitForSelector(`${HOST_SELECTOR}[data-floating="${floating}"]`);
  const waitHandleCount = (count) =>
    page.waitForFunction(
      ({ selector, count }) => document.querySelectorAll(selector).length === count,
      { selector: RESIZE_HANDLE, count },
    );
  // 夹具状态读写必须走 page.evaluate（主世界）：waitForFunction 跑在隔离世界，
  // 那里看不到夹具挂在 window 上的对象，只能查 DOM。
  const waitForFixture = async (predicate, label) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await page.evaluate(predicate)) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`fixture state timeout: ${label}`);
  };
  const reportStatus = (status) =>
    page.evaluate((next) => window.fullViewFixture.reportStatus(next), status);
  const floatingStatus = (overrides = {}) => ({
    running: false,
    blockingInteractionId: null,
    ownerKey: "task-a",
    latestTurn: null,
    ...overrides,
  });
  // 宿主几何是布局投影（ResizeObserver + CSS 过渡异步应用）；断言前等它落到目标位置。
  const waitHostAnchored = (corner) =>
    page.waitForFunction(
      ({ id, corner }) => {
        const host = document.querySelector(`[data-testid="${id}"]`);
        const slot = document.querySelector('[data-side-pane-content-slot=""]');
        if (!host || !slot) return false;
        const h = host.getBoundingClientRect();
        const s = slot.getBoundingClientRect();
        const left = Math.abs(h.left - (s.left + 16)) < 2;
        const right = Math.abs(h.right - (s.right - 16)) < 2;
        const top = Math.abs(h.top - (s.top + 16)) < 2;
        const bottom = Math.abs(h.bottom - (s.bottom - 16)) < 2;
        return corner === "top-left" ? left && top : right && bottom;
      },
      { id: TID.host, corner },
    );
  const waitHostHeight = (predicate) =>
    page.waitForFunction(
      ({ id, min, max }) => {
        const host = document.querySelector(`[data-testid="${id}"]`);
        if (!host) return false;
        const height = host.getBoundingClientRect().height;
        return height >= (min ?? 0) && height <= (max ?? Number.POSITIVE_INFINITY);
      },
      { id: TID.host, ...predicate },
    );

  // ------------------------------------------------------------------ 桌面端 / 英文 / 亮色
  await visit("platform=desktop&locale=en-US&theme=light");
  assert.equal(await hostMode(), "normal", "普通视图先处于静态布局");
  assert.equal(await page.getByTestId(TID.conversationTab).count(), 0, "普通视图没有对话 tab");
  const normalConversationWidth = (await rectOf("fixture-conversation-frame")).width;
  assert.equal(await page.locator(RESIZE_HANDLE).count(), 1, "普通视图保留面板 resize handle");

  // 进入完整视图：面板 tab + 收起浮窗
  await page.getByTestId(TID.toggle).click();
  await waitFloating("collapsed");
  assert.equal(await page.locator(RESIZE_HANDLE).count(), 0, "完整视图隐藏面板 resize handle");
  assert.equal(await page.getByTestId(TID.conversationTab).count(), 1, "面板 tab 栏出现对话 tab");
  assert.equal(await page.getByTestId(TID.toggle).getAttribute("data-active"), "true");
  const sideFrameClass = await page
    .locator('[data-workspace-side-frame="true"]')
    .evaluate((element) => element.className);
  assert.match(sideFrameClass, /absolute/, "面板外框改为 absolute inset-0");
  assert.equal(
    await page.getByTestId("fixture-workspace-header").count(),
    0,
    "隐藏 WorkspaceHeader",
  );

  await waitHostAnchored("bottom-right");
  const slot = await slotRect();
  const host = await rectOf(TID.host);
  assert.ok(Math.abs(host.width - 560) < 2, `浮窗宽度应为 560，实际 ${host.width}`);
  // 浮窗对话侧使用生产 ChatPromptEditor 的单行布局（同一棵 DOM，只切样式）。
  assert.equal(
    await page.locator("[data-composer-layout]").getAttribute("data-composer-layout"),
    "inline",
    "浮窗输入框为单行布局",
  );
  await waitForFixture(
    () => typeof window.fullViewFixture.reportStatus === "function",
    "status api",
  );

  // 回答气泡：基线后的新回合结束显示回答前两行；点气泡展开消息流，点 × 只清除气泡。
  await reportStatus(
    floatingStatus({
      latestTurn: { turnKey: "turn-1", running: false, answer: null },
    }),
  );
  await reportStatus(
    floatingStatus({
      latestTurn: {
        turnKey: "turn-2",
        running: false,
        answer: { rowId: 2, text: "**First** line\nsecond line\nthird line" },
      },
    }),
  );
  const answerBubble = page.getByTestId(TID.answerBubble);
  await answerBubble.waitFor();
  assert.match(await answerBubble.innerText(), /First line second line/);
  await answerBubble.click();
  await waitFloating("expanded");
  assert.equal(await page.getByTestId(TID.answerBubble).count(), 0, "点气泡后清除并展开消息流");
  await page.getByTestId(TID.expand).click();
  await waitFloating("collapsed");
  await reportStatus(
    floatingStatus({
      latestTurn: {
        turnKey: "turn-3",
        running: false,
        answer: { rowId: 3, text: "third answer" },
      },
    }),
  );
  await page.getByTestId(TID.answerBubble).waitFor();
  await page.getByTestId(TID.answerBubbleClose).click();
  assert.equal(await page.getByTestId(TID.answerBubble).count(), 0, "× 清除回答气泡");

  // 运行中：操作栏显示 loading，与最小化圆钮同一状态源。
  await reportStatus(
    floatingStatus({
      running: true,
      latestTurn: { turnKey: "turn-4", running: true, answer: null },
    }),
  );
  await page.getByTestId("v4-composer-input").click();
  await page.getByTestId(TID.running).waitFor();
  await reportStatus(floatingStatus());

  // 最小化时出现新的阻塞交互（权限/问答）自动恢复为收起态。
  await page.getByTestId(TID.minimize).click();
  await waitFloating("minimized");
  await reportStatus(floatingStatus({ blockingInteractionId: "ask-user-1" }));
  await waitFloating("collapsed");
  await reportStatus(floatingStatus());
  assert.ok(host.height > 20 && host.height < 200, `收起态只露输入区，实际 ${host.height}`);
  assert.ok(Math.abs(host.right - (slot.right - 16)) < 2, "默认吸附右下");
  assert.ok(Math.abs(host.bottom - (slot.bottom - 16)) < 2, "默认吸附右下");

  // 聚焦输入区 → 抽屉/操作栏出现；展开 → 消息流可见
  await page.getByTestId("v4-composer-input").click();
  await page.getByTestId(TID.header).waitFor();
  await page.getByTestId(TID.expand).click();
  await waitFloating("expanded");
  await waitHostHeight({ min: 638, max: 642 });
  assert.ok((await rectOf(TID.host)).height > host.height + 100, "展开态露出消息流");
  assert.equal(await page.getByTestId(TID.header).isVisible(), true, "展开态操作栏常显");

  // 拖动 ⠿ 到左上吸附 + 偏好持久化
  const handleBox = await page.getByTestId(TID.handle).boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(slot.left + 40, slot.top + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    () => localStorage.getItem("zcode:side-pane-full-view:floating-anchor") === "top-left",
  );
  await waitHostAnchored("top-left");
  const anchored = await rectOf(TID.host);
  assert.ok(Math.abs(anchored.left - (slot.left + 16)) < 2, `吸附左上 left=${anchored.left}`);
  assert.ok(Math.abs(anchored.top - (slot.top + 16)) < 2, `吸附左上 top=${anchored.top}`);

  // 最小化 → 圆钮 → 恢复收起态并聚焦输入框
  await page.getByTestId(TID.minimize).click();
  await waitFloating("minimized");
  // 最小化 ↔ 恢复用 150ms 缩放淡入（不是宽高过渡），等动画结束后再量尺寸。
  await waitHostHeight({ max: 49 });
  await page.waitForTimeout(220);
  const minimized = await rectOf(TID.host);
  assert.ok(
    Math.abs(minimized.width - 48) < 1 && Math.abs(minimized.height - 48) < 1,
    `最小化为 48×48，实际 ${minimized.width}×${minimized.height}`,
  );
  await page.getByTestId(TID.bubble).click();
  await waitFloating("collapsed");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "v4-composer-input",
  );
  await page.getByTestId(TID.header).waitFor();

  // 单实例：切换 surface / 形态过程中草稿、滚动、上传都只有一份
  await page.keyboard.type("draft survives");
  await page.getByTestId("fixture-attach").click();
  await page.getByTestId("fixture-scroll").evaluate((element) => {
    element.scrollTop = 640;
  });
  const scroll = () => page.getByTestId("fixture-scroll").evaluate((element) => element.scrollTop);
  const scrollBefore = await scroll();
  assert.ok(scrollBefore > 600, "测试桩滚动已生效");

  // 对话 tab：全宽铺满面板内容区
  await page.getByTestId(TID.conversationTab).click();
  await waitMode("conversation");
  const conversationSlot = await slotRect();
  const conversationHost = await rectOf(TID.host);
  assert.ok(
    Math.abs(conversationHost.width - conversationSlot.width) < 2 &&
      Math.abs(conversationHost.height - conversationSlot.height) < 2,
    "对话 surface 铺满 slot",
  );

  // 回到面板 tab（浮窗）：同一个对话实例，草稿/滚动/上传都在
  await page.locator('[data-side-pane-tab-id="board"]').click();
  await waitMode("floating");
  await waitForFixture(() => window.fullViewFixture.mounts === 1, "conversation mounted once");
  assert.equal(await page.evaluate(() => window.fullViewFixture.draft), "draft survives");
  assert.equal(await scroll(), scrollBefore, "滚动位置保留");
  assert.equal(await page.locator('[data-testid="fixture-uploads"] li').count(), 1, "上传项保留");

  // 快捷键（⇧⌘F / Ctrl+Shift+F）退出，宽度/终端等原有布局不变
  await page.keyboard.press("Control+Shift+KeyF");
  await waitMode("normal");
  assert.equal(await page.evaluate(() => window.fullViewFixture.mounts), 1, "退出不重新挂载对话");
  assert.equal(
    (await rectOf("fixture-conversation-frame")).width,
    normalConversationWidth,
    "退出后对话列宽度不变",
  );
  await waitHandleCount(1);

  // 快捷键再进入；关闭面板 → 立即退出；再打开不回到完整视图
  await page.keyboard.press("Control+Shift+KeyF");
  await waitMode("floating");
  await page.getByTestId(TID.sidePaneToggle).click();
  await waitForFixture(() => window.fullViewFixture.paneOpen === false, "panel closed");
  await page.evaluate(() => window.fullViewFixture.togglePane());
  await page.getByTestId(TID.host).waitFor();
  assert.equal(await hostMode(), "normal", "重新打开面板不回到完整视图");

  // 面板关闭时按快捷键：先落记录再打开面板，展开后即进入完整视图
  await page.evaluate(() => window.fullViewFixture.togglePane());
  await waitForFixture(() => window.fullViewFixture.paneOpen === false, "panel closed again");
  await page.keyboard.press("Control+Shift+KeyF");
  await waitMode("floating");
  assert.equal(await page.evaluate(() => window.fullViewFixture.paneOpen), true, "快捷键打开面板");

  // 切 owner 记忆：A 的 expanded 记录切走再回来恢复，B 没有记录
  await page.getByTestId("v4-composer-input").click();
  await page.getByTestId(TID.expand).click();
  await waitFloating("expanded");
  await page.evaluate(() => window.fullViewFixture.setOwner("task-b"));
  await waitMode("normal");
  await page.evaluate(() => window.fullViewFixture.setOwner("task-a"));
  await waitFloating("expanded");

  // 窗口 resize：吸附偏好持久，浮窗跟着 slot 重新定位（宽度上限仍 560）
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitHostAnchored("top-left");
  const resizedHost = await rectOf(TID.host);
  const resizedSlot = await slotRect();
  assert.ok(Math.abs(resizedHost.width - 560) < 2, "resize 后宽度上限不变");
  assert.ok(Math.abs(resizedHost.left - (resizedSlot.left + 16)) < 2, "resize 后仍贴左上 16px");

  // 多 pane：入口显式禁用；回到单 pane 恢复入口（不静默改分屏布局）
  await page.evaluate(() => window.fullViewFixture.splitPane());
  await page.waitForFunction(
    () => document.querySelector('[data-testid="fixture-pane-count"]')?.textContent === "2",
  );
  assert.equal(await hostMode(), "normal", "多 pane 时不应用完整视图");
  assert.equal(await page.getByTestId(TID.toggle).isDisabled(), true, "多 pane 时入口按钮禁用");
  await page.evaluate(() => window.fullViewFixture.resetPanes());
  await page.waitForFunction(
    () => document.querySelector('[data-testid="fixture-pane-count"]')?.textContent === "1",
  );
  await waitMode("floating");
  assert.equal(await page.getByTestId(TID.toggle).isDisabled(), false, "单 pane 后入口恢复");
  await page.getByTestId(TID.toggle).click();
  await waitMode("normal");

  // ------------------------------------------------------------------ 中文 / 暗色
  await visit("platform=desktop&locale=zh-CN&theme=dark");
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    true,
    "暗色主题生效",
  );
  assert.equal(
    await page.getByTestId(TID.toggle).getAttribute("aria-label"),
    "进入完整视图",
    "中文入口文案",
  );
  await page.getByTestId(TID.toggle).click();
  await waitMode("floating");
  assert.equal(
    await page.getByTestId(TID.conversationTab).getAttribute("title"),
    "task-a",
    "对话 tab 使用当前任务标题",
  );

  // ------------------------------------------------------------------ Web：没有入口、不注册快捷键
  await visit("platform=web&locale=en-US&theme=light");
  assert.equal(await page.getByTestId(TID.toggle).count(), 0, "Web 不渲染完整视图入口");
  assert.equal(await page.getByTestId(TID.conversationTab).count(), 0, "Web 没有对话 tab");
  await page.keyboard.press("Control+Shift+KeyF");
  await page.waitForTimeout(150);
  assert.equal(await hostMode(), "normal", "Web 快捷键不触发完整视图");

  assert.deepEqual(errors, [], `页面不应有运行时错误：${errors.join(" | ")}`);
  assert.deepEqual(external, [], `不应有外部网络请求：${external.join(", ")}`);
  console.log(
    "Side pane full view walkthrough passed: enter/exit, two surfaces, floating collapsed/expanded/minimized, drag snap + persisted anchor, owner memory, window resize, single mounted conversation (draft/scroll/upload preserved), split-pane entry disabled, zh/en + light/dark, Web has no entry or shortcut.",
  );
} finally {
  await browser?.close();
  server.close();
}
