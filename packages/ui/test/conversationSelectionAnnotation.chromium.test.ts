// 真实 Chromium：生产 `ConversationSelectionTooltip` + `SelectionActionMenu` 的批注交互。
//
// 覆盖三条 GUI 事实（纯函数单测覆盖不到）：
// 1. 选区 → 菜单 → 批注输入框获得焦点后菜单**不关闭**（选区塌缩被冻结）；
// 2. 确认批注 → 交出的引用带 comment，且与“加入对话”走同一个回调（同一草稿 owner）；
// 3. 取消 / Esc → 不交出任何引用，Composer 侧不会收到未确认的批注。
//
// loopback 静态服务 + 现场 esbuild 打包，不读用户 workspace/profile。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let server: Server;
let pageUrl: string;
let tempRoot: string;

const ENTRY = `
import { createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";

const row = {
  rowId: 7,
  turnId: "turn-1",
  kind: "assistantText",
  createdAt: 1,
  text: "await load(); await load();",
};

function Harness() {
  const rootRef = useRef(null);
  window.__annotations = [];
  return createElement(
    "div",
    { ref: rootRef, "data-test-root": "true", style: { padding: 40 } },
    createElement(
      "div",
      { "data-row-id": "7", "data-conversation-selectable": "true" },
      "await load(); await load();",
    ),
    createElement(ConversationSelectionTooltip, {
      rootRef,
      rows: [row],
      sourceSessionId: "session-a",
      sourceLogEpoch: "epoch-1",
      enabled: true,
      onAddToCurrentTask: (reference) => window.__annotations.push(reference),
      onAskInSideChat: () => undefined,
    }),
  );
}

createRoot(document.getElementById("root")).render(
  createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, createElement(Harness)),
);
`;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-quote-annotation-"));
  const bundled = await build({
    bundle: true,
    define: { "process.env.NODE_ENV": '"development"' },
    entryPoints: [],
    format: "esm",
    jsx: "automatic",
    platform: "browser",
    stdin: { contents: ENTRY, loader: "tsx", resolveDir: join(process.cwd(), "packages/ui") },
    outfile: join(tempRoot, "app.mjs"),
    tsconfig: join(process.cwd(), "packages/ui/tsconfig.json"),
    write: false,
  });
  const appSource = bundled.outputFiles?.[0]?.text ?? "";
  server = createServer((request, response) => {
    if (request.url === "/app.mjs") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(appSource);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      [
        "<!doctype html><html><head><meta charset='utf-8'><title>quotes</title></head>",
        "<body><div id='root'></div><script type='module' src='/app.mjs'></script></body></html>",
      ].join(""),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  pageUrl = `http://127.0.0.1:${port}/`;
  browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

/** 页面内的记录数组（客户端回调写入）。 */
async function readAnnotations(page: Page): Promise<Array<Record<string, unknown>>> {
  return await page.evaluate(
    () =>
      (window as unknown as { __annotations?: Array<Record<string, unknown>> }).__annotations ?? [],
  );
}

async function openPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(pageUrl);
  await page.waitForSelector("[data-test-root='true']");
  return page;
}

async function selectPassage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = document.querySelector("[data-conversation-selectable='true']");
    if (!target) throw new Error("selectable passage missing");
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitForSelector("[data-conversation-selection-action='add-to-task']");
}

describe("选区批注输入框", () => {
  it("输入框获得焦点后菜单仍在；确认后交出带 comment 的同一条引用", async () => {
    const page = await openPage();
    await selectPassage(page);
    await page.click("[data-conversation-selection-action='annotate']");
    const textarea = page.locator("[data-conversation-selection-annotation='true']");
    await expect.poll(async () => await textarea.count()).toBe(1);
    await textarea.fill("为什么 await 两次？");
    // 焦点在输入框里（window 选区已塌缩），菜单仍必须可见。
    await expect.poll(async () => await textarea.isVisible()).toBe(true);
    await page.click("[data-conversation-selection-action='submit-annotation']");
    const annotations = await readAnnotations(page);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      comment: "为什么 await 两次？",
      sourceLogEpoch: "epoch-1",
      text: "await load(); await load();",
    });
    await page.close();
  });

  it("取消不交出引用；菜单回到普通动作且草稿不泄漏", async () => {
    const page = await openPage();
    await selectPassage(page);
    await page.click("[data-conversation-selection-action='annotate']");
    await page.locator("[data-conversation-selection-annotation='true']").fill("不会提交的批注");
    await page.click("[data-conversation-selection-action='cancel-annotation']");
    await expect
      .poll(
        async () => await page.locator("[data-conversation-selection-action='annotate']").count(),
      )
      .toBe(1);
    expect(await readAnnotations(page)).toHaveLength(0);
    // 重新打开批注框时是空的：取消没有把草稿留在别处。
    await page.click("[data-conversation-selection-action='annotate']");
    expect(await page.locator("[data-conversation-selection-annotation='true']").inputValue()).toBe(
      "",
    );
    expect(await readAnnotations(page)).toHaveLength(0);
    await page.close();
  });

  it("空批注不能提交，Esc 关闭批注框也不交出引用", async () => {
    const page = await openPage();
    await selectPassage(page);
    await page.click("[data-conversation-selection-action='annotate']");
    const textarea = page.locator("[data-conversation-selection-annotation='true']");
    await expect.poll(async () => await textarea.count()).toBe(1);
    expect(
      await page.locator("[data-conversation-selection-action='submit-annotation']").isDisabled(),
    ).toBe(true);
    await textarea.press("Escape");
    await expect
      .poll(async () => await page.locator("[data-conversation-selection-tooltip='true']").count())
      .toBe(0);
    expect(await readAnnotations(page)).toHaveLength(0);
    await page.close();
  });
});
