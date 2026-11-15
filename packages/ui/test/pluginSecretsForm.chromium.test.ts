// 真实 Chromium：插件敏感配置表单（生产 PluginConfigControls + pluginConfigPatch）。
//
// 覆盖纯函数单测覆盖不到的 GUI 事实：
// 1. 已保存的敏感值不回显（password 输入 + 明确「已保存」提示），普通字段照常回显；
// 2. 不改动即保存 → patch 为空，不写空配置也不清掉已存密钥；
// 3. 输入新值 → patch 带新值；显式 clear → patch 只带 clearOptionKeys，再点一次撤销意图。
//
// loopback 静态服务 + 现场 esbuild 打包，不读用户 workspace/profile，不写真实配置。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
let server: Server;
let pageUrl: string;

const ENTRY = `
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PluginConfigControls } from "@/settings/PluginConfigControls.js";
import {
  buildPluginConfigPatch,
  resolvePluginOptionValue,
} from "@/settings/pluginConfigPatch.js";

// 与服务端私有存储一致的投影：敏感值不回传，只保留 optionSources 标记。
const PLUGIN = {
  id: "secret-plugin@inline",
  name: "secret-plugin",
  enabled: true,
  source: "inline",
  marketplace: "inline",
  skillCount: 0,
  skillRootCount: 0,
  commandRootCount: 0,
  components: [],
  declaredMcpServerNames: [],
  mcpServerNames: [],
  hookDetails: [],
  rootPath: "/tmp/fixture/secret-plugin",
  userConfig: {
    token: { sensitive: true, title: "API token", type: "string" },
    region: { title: "Region", type: "string", default: "us" },
  },
  configuredOptions: { region: "eu" },
  // Workspace 视图：两个键都由 workspace 层提供，clear 才对当前 scope 生效。
  optionSources: { region: "workspace", token: "workspace" },
};

function Harness() {
  const [drafts, setDrafts] = useState({});
  const [saved, setSaved] = useState("{}");
  const plugin = PLUGIN;
  const setDraft = (pluginId, key, value) =>
    setDrafts((current) => ({ ...current, [pluginId]: { ...current[pluginId], [key]: value } }));
  const save = () => {
    setSaved(JSON.stringify(buildPluginConfigPatch(plugin, drafts[plugin.id] ?? {})));
    setDrafts((current) => {
      const next = { ...current };
      delete next[plugin.id];
      return next;
    });
  };
  return (
    <div className="p-4" data-testid="fixture-shell">
      <PluginConfigControls
        getOptionState={(target, key, option) =>
          resolvePluginOptionValue(target, key, option, drafts[target.id]?.[key])
        }
        isOptionClearPending={(pluginId, key) => drafts[pluginId]?.[key] === null}
        onClearOption={(pluginId, key, clear) =>
          setDrafts((current) => {
            const nextPluginDrafts = { ...current[pluginId] };
            if (clear) nextPluginDrafts[key] = null;
            else delete nextPluginDrafts[key];
            return { ...current, [pluginId]: nextPluginDrafts };
          })
        }
        onSave={save}
        onSetDraft={setDraft}
        operationId={null}
        plugin={plugin}
        scope="workspace"
      />
      <output data-testid="saved-patch">{saved}</output>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <Harness />
  </ZCodeIntlProvider>,
);
`;

const SECRET_INPUT = '[data-testid="plugin-store-config-input"][data-config-key="token"]';
const REGION_INPUT = '[data-testid="plugin-store-config-input"][data-config-key="region"]';
const CLEAR_SECRET = '[data-testid="plugin-store-config-clear"][data-config-key="token"]';
const CLEAR_REGION = '[data-testid="plugin-store-config-clear"][data-config-key="region"]';
const SAVE = '[data-testid="plugin-store-config-save"]';
const SAVED = '[data-testid="saved-patch"]';

beforeAll(async () => {
  const bundled = await build({
    bundle: true,
    define: { "process.env.NODE_ENV": '"development"' },
    entryPoints: [],
    format: "esm",
    jsx: "automatic",
    platform: "browser",
    stdin: { contents: ENTRY, loader: "tsx", resolveDir: join(process.cwd(), "packages/ui") },
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
        "<!doctype html><html><head><meta charset='utf-8'><title>plugin secrets</title></head>",
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
});

async function openPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(pageUrl);
  await page.waitForSelector(SECRET_INPUT);
  return page;
}

describe("插件敏感配置表单", () => {
  it("已保存的敏感值不回显，普通字段照常回显并显示 scope", async () => {
    const page = await openPage();
    expect(await page.getAttribute(SECRET_INPUT, "type")).toBe("password");
    expect(await page.inputValue(SECRET_INPUT)).toBe("");
    expect(await page.getAttribute(SECRET_INPUT, "data-secret-stored")).toBe("true");
    expect(await page.getAttribute(SECRET_INPUT, "placeholder")).toBe(
      "Saved securely. Leave blank to keep the current value.",
    );
    expect(await page.inputValue(REGION_INPUT)).toBe("eu");
    expect(await page.locator('[data-settings-scope="workspace"]').count()).toBe(2);
    await page.close();
  });

  it("不改动即保存产生空 patch；输入新值只带新值", async () => {
    const page = await openPage();
    await page.click(SAVE);
    expect(await page.textContent(SAVED)).toBe('{"options":{},"clearOptionKeys":[]}');

    await page.fill(SECRET_INPUT, "typed-secret");
    await page.click(SAVE);
    expect(await page.textContent(SAVED)).toBe(
      '{"options":{"token":"typed-secret"},"clearOptionKeys":[]}',
    );
    // 保存后回到「已保存但不回显」，草稿不再泄漏到输入框。
    expect(await page.inputValue(SECRET_INPUT)).toBe("");
    await page.close();
  });

  it("敏感输入清空后仍是 keep，不把空值当作新 secret", async () => {
    const page = await openPage();
    await page.fill(SECRET_INPUT, "temporary-secret");
    await page.fill(SECRET_INPUT, "");
    // 草稿存在但为空：恢复“已保存但不回显”提示，保存仍不发空值也不 clear。
    expect(await page.getAttribute(SECRET_INPUT, "data-secret-stored")).toBe("true");
    expect(await page.getAttribute(SECRET_INPUT, "placeholder")).toBe(
      "Saved securely. Leave blank to keep the current value.",
    );
    await page.click(SAVE);
    expect(await page.textContent(SAVED)).toBe('{"options":{},"clearOptionKeys":[]}');
    await page.close();
  });

  it("显式 clear 只带 clearOptionKeys，再点一次撤销意图", async () => {
    const page = await openPage();
    await page.click(CLEAR_SECRET);
    expect(await page.getAttribute(CLEAR_SECRET, "aria-pressed")).toBe("true");
    await page.click(SAVE);
    expect(await page.textContent(SAVED)).toBe('{"options":{},"clearOptionKeys":["token"]}');

    await page.click(CLEAR_SECRET);
    await page.click(CLEAR_SECRET);
    expect(await page.getAttribute(CLEAR_SECRET, "aria-pressed")).toBe("false");
    await page.click(SAVE);
    expect(await page.textContent(SAVED)).toBe('{"options":{},"clearOptionKeys":[]}');
    await page.close();
  });

  it("普通字段的 workspace override 也能显式 clear 并撤销", async () => {
    const page = await openPage();
    await page.click(CLEAR_REGION);
    await page.click(SAVE);
    expect(await page.textContent(SAVED)).toBe('{"options":{},"clearOptionKeys":["region"]}');

    await page.click(CLEAR_REGION);
    await page.click(CLEAR_REGION);
    await page.click(SAVE);
    expect(await page.textContent(SAVED)).toBe('{"options":{},"clearOptionKeys":[]}');
    await page.close();
  });
});
