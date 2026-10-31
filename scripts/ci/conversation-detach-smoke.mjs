import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const temp = await mkdtemp(resolve(tmpdir(), "zcode-detach-"));
Object.assign(process.env, {
  HOME: resolve(temp, "home"),
  XDG_CONFIG_HOME: resolve(temp, "config"),
  XDG_DATA_HOME: resolve(temp, "data"),
  XDG_CACHE_HOME: resolve(temp, "cache"),
  ZCODE_DATA_BASE_DIR: resolve(temp, "app"),
});
const { build } = await import("vite");
const output = await build({
  configFile: false,
  logLevel: "error",
  root,
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(root, "packages/ui/test/fixtures/conversation-detach.jsx"),
      output: { format: "es", codeSplitting: false },
    },
  },
});
const code = (Array.isArray(output) ? output : [output])
  .flatMap((item) => item.output)
  .find((item) => item.type === "chunk").code;
const assetDir =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const styleName = (await readdir(assetDir)).find((name) => /^styles-.*\.css$/.test(name));
assert.ok(styleName, "Build the desktop renderer before running the detach guard");
const css = await readFile(resolve(assetDir, styleName), "utf8");
const server = createServer((req, res) => {
  res.writeHead(200, {
    "content-type":
      req.url === "/fixture.js"
        ? "text/javascript"
        : req.url === "/styles.css"
          ? "text/css"
          : "text/html",
  });
  res.end(
    req.url === "/fixture.js"
      ? code
      : req.url === "/styles.css"
        ? css
        : '<!doctype html><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  const open = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page
      .getByTestId("composer-workspace-trigger")
      .waitFor()
      .catch(async (error) => {
        console.error(errors, await page.locator("body").innerText());
        throw error;
      });
  };
  const commit = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  const scope = async (next) => {
    await page.evaluate((value) => window.detachFixture.setScope(value), next);
    await commit();
  };
  // 保留生产组件实际传给菜单的 callback，而不是在夹具复制 detach 实现。
  const capture = () =>
    page.evaluate(() => {
      const element = document.querySelector('[data-testid="composer-workspace-trigger"]');
      let fiber = element[Object.keys(element).find((key) => key.startsWith("__reactFiber$"))];
      while (fiber && typeof fiber.memoizedProps?.onSelectConversationWorkspace !== "function")
        fiber = fiber.return;
      if (!fiber) throw new Error("production menu callback not found");
      window.detachCallback = fiber.memoizedProps.onSelectConversationWorkspace;
    });
  const invoke = () =>
    page.evaluate(async () => {
      await window.detachCallback();
    });
  const local = { workspacePath: "/fixture/shared" };
  const remote = {
    workspacePath: "/fixture/shared",
    workspaceIdentity: "remote-a",
    remoteSessionId: "session-a",
    remoteTarget: { kind: "ssh", host: "fixture.invalid", port: 22, username: "fixture" },
  };
  await open();
  await scope(remote);
  await page
    .getByTestId("composer-workspace-trigger")
    .waitFor()
    .catch(async (error) => {
      console.error(errors, await page.locator("body").innerText());
      throw error;
    });
  assert.equal(
    await page.getByTestId("composer-project-detach").count(),
    0,
    "remote chip must not detach",
  );
  await page.getByTestId("composer-workspace-trigger").click();
  assert.equal(
    await page.getByTestId("composer-work-outside-project").count(),
    0,
    "remote menu must not work outside project",
  );
  await page.keyboard.press("Escape");

  // 当前远端 callback（非陈旧）同样不得启动本机解析。
  await capture();
  await invoke();
  assert.equal(await page.evaluate(() => window.detachFixture.ensures), 0);
  await page.evaluate(async () => {
    try {
      await window.detachFixture.resolve(() => false);
    } catch {
      /* stale admission */
    }
  });
  assert.equal(
    await page.evaluate(() => window.detachFixture.ensures),
    0,
    "Root consumes admission before IO",
  );

  for (const [from, to] of [
    [remote, local],
    [remote, { ...remote, workspaceIdentity: "remote-b" }],
    [remote, { ...remote, remoteSessionId: "session-b" }],
    [remote, { ...remote, remoteTarget: { ...remote.remoteTarget, host: "other.invalid" } }],
    [local, remote],
    [local, { workspacePath: "/fixture/local-b" }],
    [local, { workspacePath: local.workspacePath, workspaceIdentity: "identity-only" }],
    [local, { workspacePath: local.workspacePath, remoteTarget: remote.remoteTarget }],
    [local, { workspacePath: local.workspacePath, remoteSessionId: "session-only" }],
  ]) {
    await open();
    await scope(from);
    await capture();
    await scope(to);
    await invoke();
    await commit();
    assert.equal(
      await page.evaluate(() => window.detachFixture.ensures),
      0,
      "stale callback: zero local IO",
    );
    assert.equal(
      await page.evaluate((value) => window.detachFixture.consumeTransfer(value), from),
      false,
      "stale callback: zero draft transfer",
    );
    assert.equal(
      await page.evaluate(() => window.detachFixture.active().path),
      to.workspacePath,
      "stale callback: zero navigation",
    );
  }
  for (const fail of [false, true]) {
    await open();
    await scope(local);
    await capture();
    await page.evaluate((fail) => {
      window.detachFixture.arm(fail);
      window.pendingDetach = window.detachCallback();
    }, fail);
    await page.waitForFunction(() => window.detachFixture.barrier.started);
    await scope(remote);
    await page.evaluate(() => window.detachFixture.setError("current-scope-error"));
    await page.evaluate(async () => {
      window.detachFixture.release();
      await window.pendingDetach;
    });
    await commit();
    assert.equal(
      await page.evaluate(() => window.detachFixture.error),
      "current-scope-error",
      "stale Root IO cannot clear or replace current errors",
    );
    assert.equal(
      await page.evaluate((value) => window.detachFixture.consumeTransfer(value), local),
      false,
    );
    assert.equal(
      await page.evaluate(() => window.detachFixture.active().identity),
      remote.workspaceIdentity,
    );
  }
  await open();
  await scope(local);
  await capture();
  await page.evaluate(() => window.detachFixture.setMounted(false));
  await commit();
  await invoke();
  assert.equal(
    await page.evaluate(() => window.detachFixture.ensures),
    0,
    "unmounted callback cannot ensure",
  );
  await open();
  await scope(remote);
  await scope(local);
  // 同路径远端 tab 保留在列表中，空 identity 仍必须命中本地项目。
  await page.getByTestId("composer-project-detach").click();
  await commit();
  assert.equal(await page.evaluate(() => window.detachFixture.ensures), 1);
  assert.equal(
    await page.evaluate(() => window.detachFixture.active().path),
    "/fixture/conversation",
    "valid local detach still navigates",
  );
  await page.evaluate(async () => {
    await window.detachFixture.createConversation();
  });
  assert.equal(
    await page.evaluate(() => window.detachFixture.ensures),
    2,
    "independent conversation + remains enabled",
  );
  assert.deepEqual(errors, []);
  console.log(
    "conversation-detach smoke: PASS (production App/Shell/menu + Root actions, remote hidden, 9 stale callbacks + unmount, Root admission, 2 deferred IO, local success)",
  );
} finally {
  if (browser) await browser.close();
  server.close();
  await rm(temp, { recursive: true, force: true });
}
