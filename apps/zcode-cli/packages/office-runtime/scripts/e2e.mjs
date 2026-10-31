#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readPluginName } from "./plugin-name.mjs";
import { runScenarios } from "./e2e/scenarios.mjs";

/**
 * Real bundled server + official AppBridge host + the panel in an iframe that carries the ZCode
 * sandbox CSP (no network, wasm only by declaration). The script plays the agent: it calls the
 * server's model tools, forwards results to the page and calls the page's capture_view tool.
 * This does not exercise the Electron sandbox itself.
 *
 * Run it from a built plugin package; the steps follow the plugin's formats.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = process.cwd();
const name = await readPluginName(plugin);
const { kinds } = JSON.parse(await readFile(join(plugin, "package.json"), "utf8")).office;
const has = (kind) => kinds.includes(kind);
const artifacts = resolve(process.env.OFFICE_E2E_ARTIFACTS || join(tmpdir(), `${name}-e2e`));
await mkdir(artifacts, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), `${name}-e2e-ws-`));
await cp(join(root, "fixtures"), join(workspace, "docs"), {
  recursive: true,
  filter: (path) => !path.endsWith(".py"),
});

const client = new Client({ name: `${name}-e2e`, version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(plugin, "dist/server.mjs")],
    cwd: workspace,
    env: { PATH: process.env.PATH ?? "", ZCODE_WORKSPACE_ROOT: workspace },
    stderr: "inherit",
  }),
);
const panel = await client.readResource({ uri: `ui://${name}/panel.html` });
const html = panel.contents[0].text;
const relaxed = panel.contents[0]._meta?.["zcode/csp"]?.wasmUnsafeEval === true;
// CSP 只能反映产物真实需要：pdf/spreadsheets 用 wasm，documents/presentations 不该带该能力。
if (relaxed !== (has("pdf") || has("xlsx")))
  throw new Error(`${name}: unexpected wasmUnsafeEval declaration (${relaxed})`);
// Same directives as the desktop sandbox (packages/desktop/src/main/pluginSandbox/csp.ts).
const csp = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' blob: data:${relaxed ? " 'wasm-unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "form-action 'none'",
].join("; ");

const hostJs = await build({
  stdin: {
    contents: `
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
const rpc = async (method, args) => {
  const response = await fetch('/rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({method,args})});
  const result = await response.json(); if (!response.ok) throw Error(result.error); return result;
};
const params = new URLSearchParams(location.search);
const context = { theme: params.get('theme') || 'light', locale: params.get('locale') || 'en-US', displayMode: params.get('mode') || 'fullscreen' };
const bridge = new AppBridge(null, {name:'office-e2e',version:'1'}, {serverTools:{},serverResources:{},message:{text:{}},updateModelContext:{text:{}},openLinks:{},experimental:{"zcode/surface":{id:"panel",stateKey:params.get("tab")||"first"}}}, {hostContext:context});
window.__messages = []; window.__context = null; window.__links = []; window.__initializations = 0;
bridge.oncalltool = (args) => rpc('callTool', args);
bridge.onreadresource = (args) => rpc('readResource', args);
bridge.onmessage = async (p) => { window.__messages.push(p.content[0].text); return {}; };
bridge.onupdatemodelcontext = async (p) => { window.__context = p; return {}; };
bridge.onopenlink = async (p) => { window.__links.push(p.url); return {}; };
bridge.onsizechange = () => {};
bridge.oninitialized = () => { window.__initializations++; };
window.__sendToolResult = (result) => bridge.sendToolResult(result);
window.__callPageTool = (name, args) => bridge.callTool({ name, arguments: args });
window.__listPageTools = () => bridge.listTools({});
const frame = document.querySelector('iframe');
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.src = '/panel';
`,
    resolveDir: root,
    sourcefile: "browser-host.mjs",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<style>html,body{margin:0;width:100%;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe sandbox="allow-scripts allow-same-origin allow-forms"></iframe><script type="module" src="/host.js"></script>',
      );
    } else if (url.pathname === "/host.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(hostJs.outputFiles[0].text);
    } else if (url.pathname === "/panel") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", csp);
      response.end(html);
    } else if (request.method === "POST" && url.pathname === "/rpc") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { method, args } = JSON.parse(body);
      const result =
        method === "readResource" ? await client.readResource(args) : await client.callTool(args);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    } else if (url.pathname === "/favicon.ico") response.writeHead(204).end();
    else response.writeHead(404).end();
  } catch (error) {
    response
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" },
);
const errors = [];
let opened = 0;
const open = async (
  query = "",
  viewport = { width: Number(process.env.OFFICE_E2E_WIDTH || 900), height: 900 },
  init = null,
) => {
  const outer = await browser.newPage({ viewport });
  if (init) await outer.addInitScript(init);
  outer.on("pageerror", (error) => errors.push(`pageerror: ${error}`));
  outer.on("console", (message) => {
    if (message.type() === "error" && !/favicon/.test(message.text()))
      errors.push(`console: ${message.text()}`);
  });
  const target = new URL(`${base}/${query}`);
  if (!target.searchParams.has("tab"))
    target.searchParams.set("tab", opened++ === 0 ? "first" : `window-${opened}`);
  await outer.goto(target.href);
  await outer.waitForFunction(() => window.__initializations === 1);
  const frame = outer.frames().find((item) => item !== outer.mainFrame());
  assert.ok(frame, "panel iframe exists");
  await frame.locator(".app").waitFor();
  return { outer, frame };
};
/** Play the agent: call a model tool on the server and push the result to the page like the host does. */
const agent = async (outer, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  await outer.evaluate((value) => window.__sendToolResult(value), result);
  return result;
};
const capture = async (outer, args, file) => {
  const result = await outer.evaluate(
    (value) => window.__callPageTool("capture_view", value),
    args,
  );
  assert.ok(!result.isError, JSON.stringify(result.content));
  const image = result.content.find((item) => item.type === "image");
  assert.equal(image.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  assert.ok(bytes.length > 2000, `${file}: capture is not blank (${bytes.length} bytes)`);
  await writeFile(join(artifacts, file), bytes);
  return result.content.find((item) => item.type === "text").text;
};
const getView = async () =>
  (await client.callTool({ name: "get_view", arguments: { viewId: "first" } })).content[0].text;
const waitForView = async (pattern) => {
  for (let i = 0; i < 40; i++) {
    const text = await getView();
    if (pattern.test(text)) return text;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`view never matched ${pattern}: ${await getView()}`);
};

await runScenarios({
  assert,
  open,
  agent,
  capture,
  getView,
  waitForView,
  artifacts,
  workspace,
  root,
  base,
  has,
  name,
  kinds,
  browser,
  server,
  client,
  errors,
});
