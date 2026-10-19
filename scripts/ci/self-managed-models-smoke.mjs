import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/self-managed-models.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  outdir: resolve(tmpdir(), "zcodium-model-settings-fixture"),
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = outputFiles.find((file) => file.path.endsWith(".js")).contents;
let css = "";
// 保存包含失焦引发的布局更新；必须用真实产品样式验证点击完整性。
{
  const directory =
    process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
  const file = (await readdir(directory)).find((name) => /^styles-.*\.css$/.test(name));
  assert.ok(file, "Desktop production CSS must exist for visual walkthrough");
  css = await readFile(resolve(directory, file), "utf8");
}
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
    return;
  }
  if (request.url === "/styles.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
    return;
  }
  if (request.url?.startsWith("/assets/")) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
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
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    requests.push(route.request().url());
    return route.abort();
  });

  for (const locale of ["zh-CN", "en-US"])
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?locale=${locale}&mode=create-failure&theme=${width === 1280 ? "dark" : "light"}`,
      );
      const picker = page.getByTestId("model-provider-template-picker");
      await picker.waitFor();
      assert.equal(await page.getByTestId("model-provider-template-back-button").count(), 0);
      assert.equal(await page.getByText("Official account", { exact: true }).count(), 0);
      const create = page.getByTestId("model-provider-template-item-fixture-api");
      await create.focus();
      await page.keyboard.press("Enter");
      const retry = page.getByRole("button", {
        name: locale === "zh-CN" ? "重试" : "Retry",
        exact: true,
      });
      await retry.waitFor();
      assert.equal(await page.getByTestId("model-provider-base-url-input").count(), 0);
      await retry.click();
      const base = page.getByTestId("model-provider-base-url-input");
      await base.waitFor();
      await base.fill("https://custom.example.invalid/v1");
      await base.press("Tab");
      await page.waitForFunction(() =>
        window.modelFixture.saves.some(
          (s) => s.config.api?.baseUrl === "https://custom.example.invalid/v1",
        ),
      );
      const key = page.getByTestId("model-provider-api-key-input");
      await page.evaluate(() => {
        window.modelFixture.failSave = true;
      });
      await key.fill("fixture-key");
      await key.press("Tab");
      await retry.waitFor();
      assert.equal(await key.inputValue(), "fixture-key");
      await retry.click();
      await page.waitForFunction(() =>
        window.modelFixture.saves.some((s) => s.config.access?.apiKey === "fixture-key"),
      );
      assert.equal(await page.getByText(/Fixture API.*(?:保存成功| saved)$/).count(), 0);
      await page.getByTestId("model-provider-add-model-button").click();
      const modelDialog = page.getByRole("dialog");
      await modelDialog
        .getByPlaceholder(locale === "zh-CN" ? "模型 ID" : "Model ID", { exact: true })
        .fill("fixture-model");
      await modelDialog
        .getByRole("button", { name: locale === "zh-CN" ? "保存" : "Save", exact: true })
        .click();
      await modelDialog.waitFor({ state: "hidden", timeout: 5000 }).catch(async (error) => {
        console.error(await modelDialog.innerText());
        throw error;
      });
      await page
        .getByTitle(locale === "zh-CN" ? "测试模型" : "Test model", { exact: true })
        .click();
      await page.waitForFunction(() => window.modelFixture.tests.length === 1);
      assert.deepEqual(await page.evaluate(() => window.modelFixture.tests[0]), {
        workspacePath: "/fixture/local",
        providerId: "personal:fixture-2",
        modelId: "fixture-model",
      });
      // 编辑已添加模型的配置并保存：savePersonalModelDraft 按 revision 做并发校验，
      // 设置页漏传 settingsRevision 时 basedOnRevision 恒为 0，这里会以冲突报错。
      await page
        .getByTitle(locale === "zh-CN" ? "编辑模型配置" : "Edit model settings", { exact: true })
        .click();
      const editDialog = page.getByRole("dialog");
      const contextWindowInput = editDialog.getByLabel(
        locale === "zh-CN" ? "上下文窗口" : "Context window",
        { exact: true },
      );
      await contextWindowInput.fill("16000");
      await editDialog
        .getByRole("button", { name: locale === "zh-CN" ? "保存" : "Save", exact: true })
        .click();
      await editDialog.waitFor({ state: "hidden", timeout: 5000 }).catch(async (error) => {
        console.error(await editDialog.innerText());
        throw error;
      });
      assert.equal(await page.evaluate(() => window.modelFixture.draftSaves.length), 1);
      assert.deepEqual(
        await page.evaluate(() => ({
          providerId: window.modelFixture.draftSaves[0].providerId,
          originalModelId: window.modelFixture.draftSaves[0].originalModelId,
          nextModelId: window.modelFixture.draftSaves[0].nextModelId,
        })),
        {
          providerId: "personal:fixture-2",
          originalModelId: "fixture-model",
          nextModelId: "fixture-model",
        },
      );
      assert.ok(
        await page.evaluate(() => {
          const save = window.modelFixture.draftSaves[0];
          return save.basedOnRevision === save.serverRevisionAtSave && save.basedOnRevision !== 0;
        }),
        "savePersonalModelDraft must submit the current settings revision, not a stale constant",
      );
      await page.getByTestId("model-provider-fetch-models-button").click();
      await modelDialog.getByRole("checkbox", { name: "catalog-model", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await modelDialog.waitFor({ state: "hidden" });
      await page.evaluate(() => {
        window.modelFixture.failRefresh = true;
      });
      await page
        .getByRole("button", { name: locale === "zh-CN" ? "刷新" : "Refresh", exact: true })
        .click();
      await page.getByRole("alert").waitFor();
      assert.equal(await base.inputValue(), "https://custom.example.invalid/v1");
      await retry.click();
      await page.getByRole("alert").waitFor({ state: "hidden" });
      const deleteProvider = async () => {
        await page.getByTestId("model-provider-actions-button").click();
        await page.getByRole("menuitem", { name: /删除|Delete/ }).click();
        await page.getByRole("dialog").waitFor();
      };
      await deleteProvider();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(await base.inputValue(), "https://custom.example.invalid/v1");
      assert.equal(await page.evaluate(() => window.modelFixture.deleteCount), 0);
      if (process.env.ZCODE_TEST_SCREENSHOT_DIR)
        await page.screenshot({
          path: resolve(
            process.env.ZCODE_TEST_SCREENSHOT_DIR,
            `model-settings-${locale}-${width}.png`,
          ),
        });
      await deleteProvider();
      await page.evaluate(() => {
        window.modelFixture.failDelete = true;
      });
      await page.getByTestId("confirm-dialog-confirm").click();
      await page.getByRole("alert").waitFor();
      assert.equal(await base.inputValue(), "https://custom.example.invalid/v1");
      await page
        .getByRole("alert")
        .getByRole("button", { name: locale === "zh-CN" ? "重试" : "Retry", exact: true })
        .click();
      await picker.waitFor();
      assert.equal(await page.evaluate(() => window.modelFixture.deleteCount), 2);
      await page.evaluate(() => {
        window.modelFixture.holdCreate = true;
      });
      await create.dblclick();
      await page.waitForFunction(() => typeof window.releaseModelCreate === "function");
      assert.equal(await page.evaluate(() => window.modelFixture.createCount), 3);
      await page.evaluate(() => window.releaseModelCreate());
      await base.waitFor();
      await base.fill("https://keep-selection.example.invalid/v1");
      await base.press("Tab");
      await page.waitForFunction(() =>
        window.modelFixture.saves.some(
          (s) => s.config.api?.baseUrl === "https://keep-selection.example.invalid/v1",
        ),
      );
      await page.getByTestId("model-provider-add-provider-button").click();
      await create.click();
      await page.waitForFunction(() => window.modelFixture.createCount === 4);
      await page.getByTestId("model-provider-template-back-button").click();
      await page.evaluate(() => window.releaseModelCreate());
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid^="model-provider-nav-item-"]').length === 2,
      );
      assert.equal(await base.inputValue(), "https://keep-selection.example.invalid/v1");
      assert.equal(await page.getByText(/Internal fixture/).count(), 0);
    }
  for (const mode of ["read-failure", "retired-target"]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`);
    await page.getByRole("alert").waitFor();
    if (mode === "read-failure")
      await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByTestId("model-provider-template-picker").waitFor();
    assert.equal(await page.getByText(/Internal fixture|Official account/).count(), 0);
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=legacy-api`);
  await page.getByTestId("model-provider-base-url-input").waitFor();
  assert.equal(
    await page.getByTestId("model-provider-api-key-input").inputValue(),
    "fixture-existing-key",
  );
  assert.equal(await page.getByText("Official account", { exact: true }).count(), 0);
  assert.equal(await page.getByTestId("model-provider-template-picker").count(), 0);
  // Gemini 原生：按钮不禁用，点击后先给“可能不支持”的预防提示，再照常尝试并展示真实失败。
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=gemini-native&locale=en-US`);
  await page.getByTestId("model-provider-base-url-input").waitFor();
  const fetchModels = page.getByTestId("model-provider-fetch-models-button");
  assert.equal(await fetchModels.isDisabled(), false, "Gemini 原生不应禁用获取模型按钮");
  await fetchModels.click();
  await page.getByText(/usually has no model-list endpoint/).waitFor();
  await page.getByRole("alert").waitFor();
  // 提示语不能冒充失败结果：两者必须同时存在且角色不同（note vs alert）。
  assert.equal(await fetchModels.isDisabled(), false);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("note")
    .waitFor({ state: "detached" })
    .catch(() => {});

  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    "Model settings walkthrough passed: actual editor, empty-state templates, create/retry, API address/key persistence, model addition/connectivity/catalog, model config edit save with revision check, refresh failure/retry, delete cancel/failure/retry/success, double creation guard, navigation while creating, quiet autosave and failure recovery, old target and read failure, zh/en narrow/wide, no account service or external requests.",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
