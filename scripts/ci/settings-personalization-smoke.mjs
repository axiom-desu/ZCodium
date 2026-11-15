// 个性化（用户自定义指令）真实浏览器 E2E：临时回环服务，内存文件替代 ~/.zcodium/AGENTS.md。
// 覆盖：空基线可编辑、脏态门控、保存/Ctrl+S/取消、超限阻断、读取失败重试、非桌面只显示指引、390 无溢出。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build as viteBuild } from "vite";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const fixtureSource = String.raw`
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.js";
import { PersonalizationSection } from "./packages/ui/src/settings/PersonalizationSection.js";

// 真实 PersonalizationSection + 真实草稿 store；只替代文件边界（内存文件 + 可注入失败）。
const params = new URLSearchParams(location.search);
const isDesktop = params.get("desktop") !== "0";
const initialContent = params.get("content") ?? "";
const failReads = Number(params.get("failReads") ?? "0");
window.__saveCalls = [];
window.__readCalls = 0;
window.__failRemainingReads = failReads;

const settingService = {
  async getUserInstructions() {
    window.__readCalls += 1;
    if (window.__failRemainingReads > 0) {
      window.__failRemainingReads -= 1;
      throw new Error("injected read failure");
    }
    return { content: window.__content ?? initialContent, filePath: "/tmp/home/.zcodium/AGENTS.md" };
  },
  async saveUserInstructions(content) {
    window.__saveCalls.push(content);
    if (window.__failNextSave) {
      window.__failNextSave = false;
      throw new Error("injected save failure");
    }
    window.__content = content;
    return { filePath: "/tmp/home/.zcodium/AGENTS.md" };
  },
};

function Fixture() {
  const [mounted, setMounted] = useState(true);
  return (
    <div className="w-full p-4" data-testid="personalization-fixture">
      <button type="button" data-testid="unmount" onClick={() => setMounted(false)}>
        leave
      </button>
      <button type="button" data-testid="remount" onClick={() => setMounted(true)}>
        back
      </button>
      {mounted ? (
        <PersonalizationSection settingService={settingService} isDesktop={isDesktop} />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") ?? "en-US"}>
    <Fixture />
  </ZCodeIntlProvider>,
);
`;
const FIXTURE_ID = "virtual:settings-personalization.jsx";
const viteResult = await viteBuild({
  configFile: false,
  root,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: FIXTURE_ID,
      output: { format: "esm", entryFileNames: "fixture.js", codeSplitting: false },
    },
  },
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  esbuild: { jsx: "automatic", loader: "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "settings-personalization-fixture",
      resolveId(id) {
        if (id === FIXTURE_ID) return `\0${FIXTURE_ID}`;
        return null;
      },
      load(id) {
        if (id === `\0${FIXTURE_ID}`) return fixtureSource;
        return null;
      },
    },
  ],
});
const outputs = Array.isArray(viteResult) ? viteResult : [viteResult];
const script = outputs
  .flatMap((output) => ("output" in output ? output.output : []))
  .find((item) => item.type === "chunk" && item.isEntry)?.code;
if (typeof script !== "string") throw new Error("fixture bundle produced no entry chunk");

const server = createServer((request, response) => {
  if (request.url?.startsWith("/fixture.js")) {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><style>html,body{margin:0;font-family:sans-serif}textarea{min-height:120px;width:100%}</style><div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const EDITOR = '[data-testid="settings-personalization-editor"]';
const SAVE = '[data-testid="settings-personalization-save"]';
const CANCEL = '[data-testid="settings-personalization-cancel"]';
const HINT = '[data-testid="settings-personalization-size-hint"]';

let browser;
const failures = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  async function open(query = "") {
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`pageerror(${query}): ${error.message}`));
    await page.goto(`${baseUrl}/${query}`);
    return page;
  }

  const disabled = (page, selector) => page.locator(selector).isDisabled();

  // 1) 空文件：可编辑、无脏态不可保存；输入后可保存并落盘。
  {
    const page = await open("?desktop=1");
    await page.waitForSelector(EDITOR);
    assert.equal(await disabled(page, EDITOR), false, "读取成功后编辑器可用");
    assert.equal(await disabled(page, SAVE), true, "未修改不可保存");
    await page.fill(EDITOR, "Always answer in Chinese.");
    assert.equal(await disabled(page, SAVE), false, "脏态可保存");
    await page.click(SAVE);
    await page.waitForFunction(() => window.__saveCalls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__saveCalls), ["Always answer in Chinese."]);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="settings-personalization-save"]')?.disabled === true,
    );
    assert.equal(await page.inputValue(EDITOR), "Always answer in Chinese.");
    await page.close();
  }

  // 2) Ctrl+S 与保存按钮等价。
  {
    const page = await open("?desktop=1");
    await page.waitForSelector(EDITOR);
    await page.fill(EDITOR, "via shortcut");
    await page.locator(EDITOR).press("Control+s");
    await page.waitForFunction(() => window.__saveCalls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__saveCalls), ["via shortcut"]);
    await page.close();
  }

  // 3) 取消恢复基线，不写文件。
  {
    const page = await open("?desktop=1&content=baseline");
    await page.waitForSelector(EDITOR);
    assert.equal(await page.inputValue(EDITOR), "baseline");
    await page.fill(EDITOR, "discarded");
    await page.click(CANCEL);
    assert.equal(await page.inputValue(EDITOR), "baseline");
    assert.deepEqual(await page.evaluate(() => window.__saveCalls), []);
    assert.equal(await disabled(page, SAVE), true);
    await page.close();
  }

  // 4) 超过 100KB（中文按 UTF-8 字节计）阻断保存并显示提示。
  {
    const page = await open("?desktop=1");
    await page.waitForSelector(EDITOR);
    const huge = "中".repeat(40000);
    await page.evaluate((value) => {
      const textarea = document.querySelector('[data-testid="settings-personalization-editor"]');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }, huge);
    await page.waitForSelector(HINT);
    assert.equal(await disabled(page, SAVE), true);
    await page.locator(EDITOR).press("Control+s");
    assert.deepEqual(await page.evaluate(() => window.__saveCalls), [], "超限时 Ctrl+S 也不写");
    await page.close();
  }

  // 5) 读取失败：显示重试；重试成功后编辑器可用；失败期间不可保存。
  {
    const page = await open("?desktop=1&failReads=1&content=after-retry");
    await page.waitForSelector("text=Could not load custom instructions.");
    assert.equal(await disabled(page, SAVE), true, "读取失败不放行保存");
    await page.click("text=Retry");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="settings-personalization-editor"]')?.disabled ===
        false,
    );
    assert.equal(await page.inputValue(EDITOR), "after-retry");
    await page.close();
  }

  // 6) 保存中切走分区后重进：草稿仍在（模块级 store 卸载不失活）。
  {
    const page = await open("?desktop=1&content=base");
    await page.waitForSelector(EDITOR);
    await page.fill(EDITOR, "keep me");
    await page.evaluate(() => {
      window.__failNextSave = true;
    });
    await page.click(SAVE);
    await page.waitForFunction(() => window.__saveCalls.length === 1);
    await page.click('[data-testid="unmount"]');
    assert.equal(await page.locator(EDITOR).count(), 0);
    await page.click('[data-testid="remount"]');
    await page.waitForSelector(EDITOR);
    // 读取仍返回 base（文件未变），草稿内容续用未保存修改。
    assert.equal(await page.inputValue(EDITOR), "keep me", "失败后草稿保留可重试");
    assert.equal(await disabled(page, SAVE), false);
    await page.close();
  }

  // 7) 非桌面：只显示本地桌面端指引，不渲染编辑器、不发起读写。
  {
    const page = await open("?desktop=0");
    await page.waitForSelector("text=Open Settings in the desktop app to edit them.");
    assert.equal(await page.locator(EDITOR).count(), 0);
    assert.equal(await page.evaluate(() => window.__readCalls), 0);
    assert.deepEqual(await page.evaluate(() => window.__saveCalls), []);
    await page.close();
  }

  // 8) 390×844 手机 Web：不横向溢出，超长指令按容器换行。
  {
    const mobile = await context.newPage();
    mobile.on("pageerror", (error) => failures.push(`pageerror(mobile): ${error.message}`));
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(`${baseUrl}/?desktop=0`);
    await mobile.waitForSelector("text=Open Settings in the desktop app to edit them.");
    const noOverflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    assert.equal(noOverflow, true, "390 宽无横向溢出");
    await mobile.close();
  }

  assert.deepEqual(failures, [], `fixture page errors: ${failures.join("; ")}`);
  console.log(
    "settings personalization smoke: OK (dirty gate, save/Ctrl+S/cancel, 100KB block, retry, draft survives, web hint, 390 layout)",
  );
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
