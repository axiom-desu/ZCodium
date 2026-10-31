import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright-core";

// 真实生产 Sidebar + 真实 Host/SQLite + 生产 CSS；全程隔离 HOME/XDG，仅 loopback。
const root = resolve(import.meta.dirname, "../..");
const temp = await mkdtemp(resolve(tmpdir(), "zcode-grouped-long-list-"));
for (const [key, dir] of Object.entries({
  HOME: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  ZCODE_DATA_BASE_DIR: "app",
})) {
  process.env[key] = resolve(temp, dir);
}
const { createProjectSidebarHostFixture } = await import("./fixtures/project-sidebar-host.ts");
const clients = new Set();
const host = await createProjectSidebarHostFixture({
  root: temp,
  onProjectChange: () => {
    for (const client of clients)
      client.write(
        `data: ${JSON.stringify({ kind: "broadcast", channel: "state:projects", payload: {} })}\n\n`,
      );
  },
});
await host.saveProject({ name: "Long list", roots: [host.paths.workspaceA] });
const group = await host.createTaskGroup("Long group");
const refs = [];
for (let n = 0; n < 80; n++) {
  const taskId = `long-${n}`;
  refs.push({ workspacePath: host.paths.workspaceA, taskId });
  await host.applyCliFacts({
    taskId,
    title: `Long row ${n}`,
    workspacePath: host.paths.workspaceA,
    createdAt: n + 1,
    updatedAt: n + 1,
  });
}
await host.groupTask(group.id, refs);
// 同一组的隐藏成员必须逐字段保留，不得由可见 preview 快照覆盖。
await host.updateTask({ op: "archive", ...refs[78] });
await host.updateTask({ op: "pin", ...refs[79], pinned: true });
const hidden = (tree) =>
  tree.taskGroups.members.filter((member) => ["long-78", "long-79"].includes(member.taskId));
const hiddenBefore = hidden(await host.readTree());
const assets =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const style = (await readdir(assets)).find((name) => /^styles-.*\.css$/.test(name));
assert.ok(style, "production renderer CSS is required");
const css = await readFile(resolve(assets, style), "utf8");
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
      input: resolve(root, "packages/ui/test/fixtures/project-sidebar.jsx"),
      output: { format: "es", codeSplitting: false },
    },
  },
});
const js = (Array.isArray(outputs) ? outputs : [outputs])
  .flatMap((entry) => entry.output)
  .find((entry) => entry.type === "chunk").code;
const moves = [];
let reads = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.url === "/fixture.js" || request.url === "/style.css") {
      response.writeHead(200, {
        "content-type": request.url.endsWith("css") ? "text/css" : "text/javascript",
      });
      response.end(request.url.endsWith("css") ? css : js);
      return;
    }
    if (request.url === "/api/project") {
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(raw.length < 1_000_000);
      }
      const { method, args = [] } = JSON.parse(raw);
      assert.ok(["readTree", "readProjects", "moveTaskGroupNode"].includes(method));
      if (method === "readTree") reads++;
      if (method === "moveTaskGroupNode") moves.push(args[0]);
      const result = await host.service[method](...args);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result ?? null));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
    );
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  await page.goto(
    `http://127.0.0.1:${server.address().port}/?workspace=${encodeURIComponent(host.paths.workspaceA)}`,
  );
  await page.getByTestId("project-view-grouped").click();
  await page.getByTestId("task-item-long-0").waitFor();
  // 记录真实 viewport，而非滚动 body 或复制版 harness 容器。
  await page.getByTestId("project-grouped-view").evaluate((root) => {
    let node = root.parentElement;
    while (
      node &&
      !(
        /(auto|scroll)/.test(getComputedStyle(node).overflowY) &&
        node.scrollHeight > node.clientHeight
      )
    )
      node = node.parentElement;
    if (!node) throw new Error("production sidebar has no scroll viewport");
    node.dataset.longListViewport = "";
  });
  const viewport = page.locator("[data-long-list-viewport]");
  const overlay = page.getByTestId("project-grouped-drag-overlay");
  const order = () =>
    page
      .locator('[data-project-grouped-drag="task"]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.projectGroupedTaskRow));
  const start = async () => {
    const source = page.getByTestId("task-item-long-0");
    await source.scrollIntoViewIfNeeded(); // 仅在 pointerdown 前定位来源。
    const box = await source.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 8, { steps: 2 });
    await overlay.waitFor();
    // 先验证 hover preview 真正改了 UI，尚无命令或额外读取。
    const target = await page
      .getByTestId(moves.length ? "task-item-long-36" : "task-item-long-2")
      .boundingBox();
    assert.ok(target);
    await page.mouse.move(target.x + target.width / 2, target.y + 3, { steps: 5 });
    await page.getByTestId("project-grouped-drop-indicator").waitFor({ state: "attached" });
  };
  const edge = async () => {
    const rect = await viewport.boundingBox();
    const target = await page.getByTestId("task-item-long-35").boundingBox();
    assert.ok(
      rect && target && target.y > rect.y + rect.height,
      "drop target must initially be below viewport",
    );
    const before = await viewport.evaluate((node) => node.scrollTop);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 4, { steps: 5 });
    // 静止指针，不用 wheel、scrollIntoView 或测试 scrollTop 代替生产 RAF。
    await page.waitForFunction(() => {
      const viewport = document.querySelector("[data-long-list-viewport]").getBoundingClientRect();
      const target = document
        .querySelector('[data-testid="task-item-long-35"]')
        .getBoundingClientRect();
      return target.top > viewport.top + 40 && target.bottom < viewport.bottom - 40;
    });
    assert.ok((await viewport.evaluate((node) => node.scrollTop)) > before + 300);
  };
  const settleFrames = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  const initialOrder = await order();
  const readsBefore = reads;
  await start();
  assert.notDeepEqual(await order(), initialOrder);
  assert.equal(moves.length, 0);
  await edge();
  assert.equal(reads, readsBefore, "preview/RAF must not read another tree");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await overlay.waitFor({ state: "detached" });
  const stopped = await viewport.evaluate((node) => node.scrollTop);
  await settleFrames();
  assert.equal(await viewport.evaluate((node) => node.scrollTop), stopped);
  assert.deepEqual(await order(), initialOrder);
  assert.equal(moves.length, 0, "Esc is zero writes");
  await start();
  await edge();
  // 先把指针移出边缘并等待 RAF 停止，再重新测量目标行；滚动中的旧 rect 不能用于提交。
  const hover = await page.getByTestId("task-item-long-35").boundingBox();
  assert.ok(hover);
  await page.mouse.move(hover.x + hover.width / 2, hover.y + hover.height / 2, { steps: 3 });
  await settleFrames();
  await settleFrames();
  const target = await page.getByTestId("task-item-long-35").boundingBox();
  assert.ok(target);
  await page.mouse.move(target.x + target.width / 2, target.y + 3, { steps: 3 });
  await page.mouse.up();
  await overlay.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.projectSidebarFixture.reads.length > 1);
  assert.equal(moves.length, 1, "one pointer drop = one CAS command");
  assert.equal(moves[0].node.task.taskId, "long-0");
  assert.equal(moves[0].anchor.node.task.taskId, "long-35");
  assert.deepEqual(hidden(await host.readTree()), hiddenBefore);

  // cancel、换代、卸载都不得遗留滚动或发第二次命令。
  for (const cancel of ["pointercancel", "epoch", "unmount"]) {
    await start();
    const rect = await viewport.boundingBox();
    const before = await viewport.evaluate((node) => node.scrollTop);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 4);
    await page.waitForFunction(
      (before) => document.querySelector("[data-long-list-viewport]").scrollTop > before + 30,
      before,
    );
    if (cancel === "pointercancel")
      await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel")));
    if (cancel === "epoch") await page.evaluate(() => window.projectSidebarFixture.swapService());
    // 用 DOM click 卸载，避免 Playwright mouse.click 额外派发 pointerup 造成一次合法提交。
    if (cancel === "unmount")
      await page.getByTestId("project-view-timeline").evaluate((element) => element.click());
    await overlay.waitFor({ state: "detached" });
    await page.mouse.up();
    await settleFrames();
    const after = await viewport.evaluate((node) => node.scrollTop);
    await settleFrames();
    assert.equal(await viewport.evaluate((node) => node.scrollTop), after);
    assert.equal(moves.length, 1);
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "passed",
      rows: 80,
      moves: moves.length,
      hiddenMembers: hiddenBefore.length,
      css: style,
      checks: "preview/edge-scroll/offscreen-drop/Esc/cancel/epoch/unmount",
    }),
  );
} finally {
  await browser?.close();
  for (const client of clients) client.end();
  await new Promise((done) => server.close(done));
  await host.close();
  await rm(temp, { recursive: true, force: true });
}
