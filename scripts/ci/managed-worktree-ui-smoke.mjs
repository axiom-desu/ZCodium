import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright-core";

// W5 受管 worktree UI 入口浏览器验证：真实 ProjectWorktreeDialog + ServiceProvider 契约，
// 只使用临时目录与 loopback；服务实现是内存夹具（不触碰真实仓库/用户数据）。
const root = resolve(import.meta.dirname, "../..");
const tempRoot = await mkdtemp(resolve(tmpdir(), "zcode-worktree-ui-"));
process.env.HOME = resolve(tempRoot, "home");
process.env.XDG_CONFIG_HOME = resolve(tempRoot, "xdg-config");
process.env.XDG_DATA_HOME = resolve(tempRoot, "xdg-data");
process.env.XDG_CACHE_HOME = resolve(tempRoot, "xdg-cache");

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
      input: resolve(root, "packages/ui/test/fixtures/managed-worktree-dialog.jsx"),
      output: { format: "es", codeSplitting: false },
    },
  },
});
const built = (Array.isArray(outputs) ? outputs : [outputs])
  .flatMap((output) => output.output)
  .find((chunk) => chunk.type === "chunk");
assert.ok(built?.code, "worktree dialog fixture bundle was not produced");

const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<div id="root"></div><script type="module" src="/app.js"></script>');
    return;
  }
  response.writeHead(200, { "content-type": "text/javascript" });
  response.end(built.code);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" ? route.continue() : route.abort();
  });

  await page.goto(baseUrl);
  await page.getByTestId("worktree-row").waitFor();
  assert.match(await page.getByTestId("worktree-row").innerText(), /Task one/);

  // 创建：Host 服务返回真实会话 id 后，入口走既有 onSelectTask 导航并关闭。
  await page.getByTestId("worktree-create").click();
  await page.waitForFunction(() => window.worktreeFixture.selected.length === 1);
  assert.deepEqual(await page.evaluate(() => window.worktreeFixture.selected), [
    ["/fixture/worktrees/cd34/repo", "task-2"],
  ]);
  assert.equal(await page.evaluate(() => window.worktreeFixture.created), 1);
  assert.equal(await page.evaluate(() => window.worktreeFixture.closed), true);

  // 二次打开：删除必须经过确认按钮，且命令参数是受管根目录。
  await page.goto(baseUrl);
  await page.getByTestId("worktree-remove").click();
  await page.getByTestId("worktree-remove-confirm").click();
  await page.waitForFunction(() => window.worktreeFixture.removed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.worktreeFixture.removed), [
    "/fixture/worktrees/ab12/repo",
  ]);

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log("managed-worktree UI smoke passed");
} finally {
  await browser?.close();
  server.close();
  await rm(tempRoot, { recursive: true, force: true });
}
