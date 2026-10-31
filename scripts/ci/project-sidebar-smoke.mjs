import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright-core";
import { runProjectSidebarViewsSmoke } from "./fixtures/project-sidebar-views.ts";
import { runProjectSidebarEpochsSmoke } from "./fixtures/project-sidebar-epochs.ts";

// S8-B 项目侧栏隔离浏览器 E2E（spec：.agents/specs/upstream-3.16-project-integration.md）。
// 夹具加载生产 WorkspaceSidebar；唯一数据源是真实 createProjectService + TaskIndexRepo（临时 HOME/XDG/SQLite）。
// 只连 loopback，不读真实用户数据，不复制项目/任务业务实现。
const root = resolve(import.meta.dirname, "../..");
const tempRoot = await mkdtemp(resolve(tmpdir(), "zcode-project-sidebar-"));
process.env.HOME = resolve(tempRoot, "home");
process.env.XDG_CONFIG_HOME = resolve(tempRoot, "xdg-config");
process.env.XDG_DATA_HOME = resolve(tempRoot, "xdg-data");
process.env.XDG_CACHE_HOME = resolve(tempRoot, "xdg-cache");
process.env.ZCODE_DATA_BASE_DIR = resolve(tempRoot, "app-data");
// 业务模块在隔离环境建好后才加载，避免静态 import 固化默认用户目录。
const { createProjectSidebarHostFixture } = await import("./fixtures/project-sidebar-host.ts");

const clients = new Set();
function sendEvent(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const response of clients) response.write(payload);
}

const host = await createProjectSidebarHostFixture({
  root: tempRoot,
  onProjectChange: () => sendEvent({ kind: "broadcast", channel: "state:projects", payload: {} }),
  onWorkspaceTaskChanged: (event) => {
    sendEvent({
      kind: "workspace",
      scope: {
        workspacePath: event.workspacePath,
        ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
      },
      event: {
        type: "workspace_task_list_changed",
        workspacePath: event.workspacePath,
        ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
        taskId: event.taskId,
        reason: event.reason,
      },
    });
  },
});

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
const built = (Array.isArray(outputs) ? outputs : [outputs])
  .flatMap((output) => output.output)
  .find((chunk) => chunk.type === "chunk");
assert.ok(built?.code, "Project sidebar fixture bundle was not produced");

function readJson(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) rejectBody(new Error("request too large"));
    });
    request.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on("error", rejectBody);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(value === undefined ? "" : JSON.stringify(value));
}

const projectMethods = new Set([
  "readDirectory",
  "readProjects",
  "readTree",
  "saveProject",
  "deleteProject",
  "moveTask",
  "reorderProjects",
  "moveTaskGroupNode",
  "prepareSession",
  "resolveSessionDirectories",
]);

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.url === "/api/project" && request.method === "POST") {
      const body = await readJson(request);
      assert.ok(projectMethods.has(body.method), `unsupported project method ${body.method}`);
      const service = body.mode === "legacy" ? host.legacyService : host.service;
      const result = await service[body.method](...(body.args ?? []));
      json(response, 200, result ?? null);
      return;
    }
    if (request.url === "/api/reserve-v4" && request.method === "POST") {
      const body = await readJson(request);
      json(response, 200, await host.reserveV4Create(body));
      return;
    }
    if (request.url === "/api/task" && request.method === "POST") {
      const body = await readJson(request);
      const result = await host.updateTask({ op: body.op, ...body.input });
      json(response, 200, result);
      return;
    }
    if (request.url === "/fixture.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(built.code);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/fixture.js"></script>',
    );
  } catch (error) {
    // 业务拒绝（缺 root/legacy 只读）是 409；5xx 只留给夹具自身错误。
    json(response, 409, error instanceof Error ? error.message : String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.clear());
  const pageErrors = [];
  const external = [];
  const failedResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // 浏览器把 4xx/5xx 资源失败也记成 console error；正文由响应断言负责，避免重复且漏掉状态码。
    if (message.text().startsWith("Failed to load resource:")) return;
    pageErrors.push(message.text());
  });
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });

  const open = async (query = "") => {
    await page.goto(`${baseUrl}/${query}`);
    await page.getByTestId("project-sidebar-section").waitFor();
  };
  const row = (name) => page.locator(`[data-project-name="${name}"]`);
  const waitRow = async (name, present = true) => {
    if (present) await row(name).waitFor();
    else await row(name).waitFor({ state: "detached" });
  };
  const openProjectMenu = async (name) => {
    await row(name).hover();
    await row(name).getByTestId("project-menu").click();
  };
  const createProject = async (name, rootPath) => {
    await page.getByTestId("project-add").click();
    await page.getByTestId("project-sidebar-create").click();
    await page.getByTestId("project-editor-dialog").waitFor();
    await page.getByTestId("project-editor-name").fill(name);
    await page.evaluate((path) => window.projectSidebarFixture.directories.push(path), rootPath);
    await page.getByTestId("project-editor-add-root").click();
    await page.getByTestId("project-editor-save").click();
    await page.getByTestId("project-editor-trust").waitFor();
    await page.getByTestId("project-editor-trust-confirm").click();
    await waitRow(name);
  };

  await open(`?workspace=${encodeURIComponent(host.paths.workspaceA)}`);
  await page.getByTestId("project-sidebar-section").getByText("No projects yet").waitFor();

  await createProject("Repo A", host.paths.workspaceA);

  // 编辑：追加第二个 root，保存前再次显示本次信任确认。
  await openProjectMenu("Repo A");
  await page.getByRole("menuitem", { name: "Edit project" }).click();
  await page.getByTestId("project-editor-dialog").waitFor();
  await page.evaluate(
    (path) => window.projectSidebarFixture.directories.push(path),
    host.paths.workspaceA2,
  );
  await page.getByTestId("project-editor-add-root").click();
  await page.getByTestId("project-editor-save").click();
  await page.getByTestId("project-editor-trust-confirm").click();
  await row("Repo A").waitFor();
  await openProjectMenu("Repo A");
  await page.getByRole("menuitem", { name: "Edit project" }).click();
  await page.getByTestId("project-editor-roots").waitFor();
  assert.equal(await page.locator('[data-testid="project-editor-roots"] li').count(), 2);
  await page.getByRole("button", { name: "Cancel" }).click();

  // 第二项目 + 置顶；Host position 仍是唯一顺序事实。
  await createProject("Repo B", host.paths.workspaceB);
  await openProjectMenu("Repo B");
  await page.getByRole("menuitem", { name: "Pin project" }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="project-row"]')[0]?.dataset.projectName === "Repo B",
  );

  // 第三项目用于同置顶组拖拽；只提交 Host reorderProjects，不在本地再存顺序。
  await createProject("Repo C", host.paths.workspaceC);
  const orderNames = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="project-row"]')].map(
        (element) => element.dataset.projectName,
      ),
    );
  assert.deepEqual(await orderNames(), ["Repo B", "Repo C", "Repo A"]);
  const cBox = await row("Repo C").boundingBox();
  const aBox = await row("Repo A").boundingBox();
  assert.ok(cBox && aBox);
  await page.mouse.move(cBox.x + 80, cBox.y + cBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cBox.x + 80, cBox.y + cBox.height / 2 - 4, { steps: 2 });
  await page.mouse.move(aBox.x + 80, aBox.y + aBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="project-row"]')]
        .map((element) => element.dataset.projectName)
        .join(",") === "Repo B,Repo A,Repo C",
  );

  // 空 reserve 行不伪装成任务；真实 CLI 事实到达后无需重启立即出现。
  const repoAId = await row("Repo A").getAttribute("data-project-id");
  assert.ok(repoAId);
  await row("Repo A").getByTestId("project-toggle").click();
  await host.reserve({
    task: { taskId: "reserved-empty", workspacePath: host.paths.workspaceA },
    projectId: repoAId,
  });
  await page.waitForTimeout(150);
  assert.equal(await page.getByText("Reserved empty").count(), 0);
  await host.applyCliFacts({
    taskId: "task-a",
    title: "Fix login",
    workspacePath: host.paths.workspaceA,
    createdAt: 1000,
    updatedAt: 2000,
    titleSource: "generated",
  });
  await row("Repo A").getByText("Fix login").waitFor();

  // 任务选择走既有 shell 导航合同（path + taskId + identity + unread 版本）。
  await row("Repo A").getByTestId("task-item-task-a").click();
  await page.waitForFunction(() =>
    window.projectSidebarFixture.selected.some((entry) => entry.taskId === "task-a"),
  );
  const selected = await page.evaluate(() => window.projectSidebarFixture.selected.at(-1));
  assert.equal(selected.path, host.paths.workspaceA);
  assert.equal(selected.taskId, "task-a");

  // 移动任务：目标缺 root 时必须显式确认，确认后原子加入并移动。
  await openProjectMenu("Repo A");
  await page.getByRole("menuitem", { name: "Move tasks…" }).click();
  await page.getByTestId("project-move-dialog").waitFor();
  await page.getByTestId("project-move-target").selectOption({ label: "Repo B" });
  await page.getByTestId("project-move-apply").click();
  await page.getByTestId("project-move-add-root").waitFor();
  await page.getByTestId("project-move-add-root").click();
  await page.getByTestId("project-move-dialog").waitFor({ state: "detached" });
  await row("Repo B").getByTestId("project-toggle").click();
  await row("Repo B").getByText("Fix login").waitFor();
  assert.equal(await row("Repo A").getByText("Fix login").count(), 0);

  // 软删保留根；恢复必须显式选择同一组 roots。
  await openProjectMenu("Repo A");
  await page.getByRole("menuitem", { name: "Delete project" }).click();
  await page.getByTestId("project-editor-delete-apply").click();
  await waitRow("Repo A", false);
  await page.getByTestId("project-add").click();
  await page.getByTestId("project-sidebar-restore").click();
  await page.getByTestId("project-restore-dialog").waitFor();
  await page.getByTestId("project-restore-Repo A").click();
  await waitRow("Repo A");
  await openProjectMenu("Repo A");
  await page.getByRole("menuitem", { name: "Edit project" }).click();
  await page.getByTestId("project-editor-roots").waitFor();
  assert.equal(await page.locator('[data-testid="project-editor-roots"] li').count(), 2);
  await page.getByRole("button", { name: "Cancel" }).click();

  // 新任务入口：真实 prepareSession 校验 root 后必须把 projectId 一并交给 shell，
  // 不能只留 targetWorkspace 把项目意图丢掉。
  const repoATree = await host.readTree();
  const repoA = repoATree.projects.find((project) => project.name === "Repo A");
  assert.ok(repoA, "Repo A must exist in the real Host tree");
  await page.evaluate(() => {
    window.projectSidebarFixture.created.length = 0;
  });
  await row("Repo A").hover();
  await row("Repo A").getByTestId("project-new-task").click();
  await page.waitForFunction(() => window.projectSidebarFixture.created.length > 0);
  const created = await page.evaluate(() => window.projectSidebarFixture.created.at(-1));
  assert.equal(created.targetWorkspace.workspacePath, host.paths.workspaceA);
  assert.equal(created.projectId, repoA.id);

  // 用 UI 交出的 projectId 走生产 Host 预占入口（reserveV4CreateSession +
  // createProjectSessionCreationPort），冻结目录必须来自真实项目 roots。
  const reserved = await fetch(`${baseUrl}/api/reserve-v4`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: created.projectId, commandId: "smoke-create-1" }),
  }).then((response) => response.json());
  assert.deepEqual(reserved.additionalDirectories, [host.paths.workspaceA2]);
  const treeAfterReserve = await host.readTree();
  assert.equal(
    treeAfterReserve.tasks.some((task) => task.taskId === reserved.sessionId),
    false,
    "空预占行在真实 CLI 事实到达前不可见",
  );
  await host.applyCliFacts({
    taskId: reserved.sessionId,
    title: "Project task",
    workspacePath: host.paths.workspaceA,
    createdAt: 1200,
    updatedAt: 1300,
  });
  const treeAfterFacts = await host.readTree();
  assert.equal(
    treeAfterFacts.tasks.find((task) => task.taskId === reserved.sessionId)?.projectId,
    repoA.id,
  );

  await runProjectSidebarViewsSmoke(page, host);

  // 旧 remote（无 virtualProjects）只读：行保留，写入口禁用并给出显式原因。
  const legacyPage = await browser.newPage();
  await legacyPage.addInitScript(() => localStorage.clear());
  const legacyErrors = [];
  legacyPage.on("pageerror", (error) => legacyErrors.push(error.message));
  await legacyPage.goto(
    `${baseUrl}/?mode=legacy&workspace=${encodeURIComponent(host.paths.legacyRoot)}`,
  );
  await legacyPage.getByTestId("project-sidebar-section").waitFor();
  const legacyRow = legacyPage.locator('[data-project-name="legacy-root"]');
  await legacyRow.waitFor();
  assert.equal(await legacyRow.getByTestId("project-new-task").isDisabled(), true);
  await legacyRow.hover();
  await legacyRow.getByTestId("project-menu").click({ force: true });
  assert.equal(await legacyPage.getByRole("menuitem", { name: "Edit project" }).isDisabled(), true);
  assert.equal(
    await legacyPage.getByRole("menuitem", { name: "Delete project" }).isDisabled(),
    true,
  );
  const legacyWrite = await legacyPage.evaluate(async () => {
    const response = await fetch("/api/project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "legacy",
        method: "saveProject",
        args: [{ name: "x", roots: [] }],
      }),
    });
    return { status: response.status, body: await response.text() };
  });
  assert.notEqual(legacyWrite.status, 200);
  assert.match(legacyWrite.body, /legacy-read-only/);
  await legacyPage.close();
  assert.deepEqual(legacyErrors, []);

  // 无 tab 的旧未归类任务仍可发现：active workspace 订阅到真实 CLI 事实后进入未归类区。
  const unassignedPage = await browser.newPage();
  await unassignedPage.addInitScript(() => localStorage.clear());
  await unassignedPage.goto(
    `${baseUrl}/?workspace=${encodeURIComponent(host.paths.unassignedRoot)}`,
  );
  await unassignedPage.getByTestId("project-sidebar-section").waitFor();
  await host.applyCliFacts({
    taskId: "task-loose",
    title: "Loose task",
    workspacePath: host.paths.unassignedRoot,
    createdAt: 1100,
    updatedAt: 2100,
    titleSource: "generated",
  });
  await unassignedPage.getByTestId("project-unassigned-tasks").getByText("Loose task").waitFor();
  await unassignedPage.close();

  await runProjectSidebarEpochsSmoke(page, host, baseUrl);

  assert.deepEqual(external, []);
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(pageErrors, []);
  console.log("project-sidebar smoke: PASS");
} finally {
  if (browser) await browser.close();
  for (const client of clients) client.end();
  server.close();
  await host.close();
  await rm(tempRoot, { recursive: true, force: true });
}
