import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyDesignStyleEdits,
  designSourcePathFromUrl,
} from "../src/browser-use/browserDesignSource.js";
import {
  buildBrowserDesignDisposeScript,
  buildBrowserDesignInspectScript,
  buildBrowserDesignPreviewScript,
  DESIGN_TARGET_ATTRIBUTE,
  parseBrowserDesignInspectResult,
  type DesignInspectSelection,
} from "../src/browser-use/browserDesignInspectScript.js";
import { createFileService } from "../../services/src/file/fileService.js";

// 真实 Chromium + loopback 页面：生产 inspect 脚本在页面里实际点选，宿主用生产源码改写函数
// 和真实 createFileService 写临时项目。验证「预览不落盘、Apply 才写、越界拒绝、CAS/取消」。
// 不启动 Electron、不读用户 profile/workspace；HOME/XDG 由调用方临时隔离。

const HTML = `<!doctype html>
<html data-zcode-design>
  <head><title>Design fixture</title></head>
  <body>
    <main>
      <h1 id="title" class="hero" style="color: #111; font-size: 24px">Hello design</h1>
      <p>Body</p>
    </main>
  </body>
</html>
`;

let browser: Browser;
let server: Server;
let pageUrl: string;
let projectRoot: string;
let projectFile: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-design-chromium-"));
  projectRoot = join(base, "project");
  await mkdir(projectRoot, { recursive: true });
  projectFile = join(projectRoot, "index.html");
  await writeFile(projectFile, HTML, "utf-8");
  server = createServer((request, response) => {
    if (request.url === "/index.html" || request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(HTML);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server did not bind");
  pageUrl = `http://127.0.0.1:${address.port}/index.html`;
  browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (projectRoot) await rm(join(projectRoot, ".."), { recursive: true, force: true });
});

async function inspectOnPage(page: Page): Promise<DesignInspectSelection> {
  const pending = page.evaluate(buildBrowserDesignInspectScript());
  await page.waitForFunction("window.__zcodeDesignInspectReady === true");
  await page.click("#title");
  const result = parseBrowserDesignInspectResult(await pending);
  if (result.status !== "selected") throw new Error(`inspect status: ${result.status}`);
  return result.selection;
}

// B7：真实 Host 会给 design 端口注入项目批准根；loopback 测试只批准临时项目 root，
// 与生产一致（renderer 不能自选 root）。
const createAuthorizedFileService = () =>
  createFileService({
    designSourceAuthority: { resolveApprovedRoots: async () => [projectRoot] },
  });

describe("browser design inspect on real Chromium loopback page", () => {
  it("inspects the selected element and previews a style without touching the file", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    const fileService = createAuthorizedFileService();
    try {
      await page.goto(pageUrl);
      const selection = await inspectOnPage(page);
      expect(selection.tagName).toBe("h1");
      expect(selection.editable.fontSize).toBe("24px");
      expect(selection.styleAttribute).toContain("color: #111");
      expect(selection.sourcePath).toEqual({
        steps: [
          { tag: "body", index: 1, siblings: 2 },
          { tag: "main", index: 0, siblings: 1 },
          { tag: "h1", index: 0, siblings: 2 },
        ],
        id: "title",
        className: "hero",
      });

      const preview = applyDesignStyleEdits(HTML, selection.sourcePath, { fontSize: "46px" });
      expect(preview?.content).toContain("font-size: 46px");
      // 预览只算内存 diff：源文件一个字节都没动。
      await expect(readFile(projectFile, "utf-8")).resolves.toBe(HTML);

      const previewed = await page.evaluate(
        buildBrowserDesignPreviewScript({
          selector: selection.selector,
          styleAttribute: selection.styleAttribute,
          styles: { "font-size": "46px" },
        }),
      );
      expect(previewed).toBe(true);
      expect(
        await page.evaluate("getComputedStyle(document.querySelector('#title')).fontSize"),
      ).toBe("46px");
      await expect(readFile(projectFile, "utf-8")).resolves.toBe(HTML);

      const written = await fileService.writeDesignSourceFile({
        rootPath: projectRoot,
        path: projectFile,
        expectedContent: preview?.content === HTML ? HTML : (preview?.content ?? HTML),
        content: preview?.content ?? HTML,
      });
      // 先用真实源文件作为 expected；上面的 preview 是 next content，先读源再写。
      expect(written).toEqual({ written: false, reason: "changed" });
      const source = (
        await fileService.readDesignSourceFile({ rootPath: projectRoot, path: projectFile })
      ).content;
      const applied = await fileService.writeDesignSourceFile({
        rootPath: projectRoot,
        path: projectFile,
        expectedContent: source,
        content: preview?.content ?? source,
      });
      expect(applied).toEqual({ written: true });
      const writtenSource = await readFile(projectFile, "utf-8");
      expect(writtenSource).toContain("font-size: 46px");
      expect(writtenSource.slice(0, writtenSource.indexOf("<h1"))).toBe(
        HTML.slice(0, HTML.indexOf("<h1")),
      );
      expect(await page.evaluate("document.querySelector('#title').style.fontSize")).toBe("46px");
    } finally {
      await page.close();
    }
  });

  it("cancels a pending inspect and restores the page style on dispose", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    try {
      await page.goto(pageUrl);
      const pending = page.evaluate(buildBrowserDesignInspectScript());
      await page.waitForFunction("window.__zcodeDesignInspectReady === true");
      await page.evaluate(
        "(() => { const dispose = window.__zcodeDesignInspectDispose; if (typeof dispose === 'function') dispose(); return true; })()",
      );
      expect(parseBrowserDesignInspectResult(await pending)).toEqual({ status: "cancelled" });

      const selection = await inspectOnPage(page);
      await page.evaluate(
        buildBrowserDesignPreviewScript({
          selector: selection.selector,
          styleAttribute: selection.styleAttribute,
          styles: { "font-size": "30px" },
        }),
      );
      expect(
        await page.evaluate("getComputedStyle(document.querySelector('#title')).fontSize"),
      ).toBe("30px");
      await page.evaluate(
        buildBrowserDesignDisposeScript(selection.selector, selection.styleAttribute),
      );
      expect(
        await page.evaluate("getComputedStyle(document.querySelector('#title')).fontSize"),
      ).toBe("24px");
      expect(
        await page.evaluate(
          `Boolean(document.querySelector(${JSON.stringify(selection.selector)})?.hasAttribute(${JSON.stringify(DESIGN_TARGET_ATTRIBUTE)}))`,
        ),
      ).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("rejects out-of-project writes and stale CAS without changing the file", async () => {
    const fileService = createAuthorizedFileService();
    const outside = join(projectRoot, "..", "outside.html");
    await writeFile(outside, "<html>outside</html>", "utf-8");
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: projectRoot,
        path: outside,
        expectedContent: "<html>outside</html>",
        content: "<html>changed</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "invalid_path" });
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: projectRoot,
        path: projectFile,
        expectedContent: "<html>stale</html>",
        content: "<html>stale</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "changed" });
  });

  it("keeps file URL path derivation and loopback URL separation explicit", () => {
    expect(designSourcePathFromUrl("file:///tmp/design/index.html")).toBe("/tmp/design/index.html");
    expect(designSourcePathFromUrl(pageUrl)).toBeNull();
  });
});
