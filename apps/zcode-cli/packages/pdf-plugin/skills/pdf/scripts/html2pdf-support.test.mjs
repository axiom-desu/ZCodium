import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import support from "./html2pdf-render-support.js";

test("prettyBytes keeps the original formatting", () => {
  assert.equal(support.prettyBytes(999), "999.0 B");
  assert.equal(support.prettyBytes(2048), "2.0 KB");
  assert.equal(support.prettyBytes(1024 * 1024), "1.0 MB");
});

test("resolveChromium returns an existing executable without launching a browser", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pdf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "chromium");
  await writeFile(executablePath, "");

  assert.deepEqual(support.resolveChromium({ executablePath: () => executablePath }), {
    status: "ok",
    executablePath,
  });
  assert.equal(
    support.resolveChromium({ executablePath: () => join(root, "missing") }).status,
    "missing",
  );
});

test("missing optional tools keep the original install guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pdf-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const emptyBin = join(root, "bin");
  await mkdir(emptyBin);

  // PATH 指向空目录：npm 不存在，require('playwright') 也不可达；loader 必须仍抛出原文提示，而不是静默降级。
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const support = require(${JSON.stringify(fileURLToPath(new URL("./html2pdf-render-support.js", import.meta.url)))});
       for (const load of ["loadPlaywright", "loadPdfLib"]) {
         try { support[load](); console.log(load + ":none"); }
         catch (error) { console.log(load + ":" + error.message); }
       }`,
    ],
    {
      encoding: "utf8",
      env: { HOME: root, PATH: emptyBin, PLAYWRIGHT_PATH: "", NODE_PATH: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^loadPlaywright:Playwright not found\. Install: npm install -g playwright$/m,
  );
  assert.match(result.stdout, /^loadPdfLib:pdf-lib not found\. Install: npm install -g pdf-lib$/m);
});

test("loaders resolve an already available tool before asking for an install", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pdf-global-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["playwright", "pdf-lib"]) {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name, version: "0.0.0-fixture", main: "index.js" }),
    );
    await writeFile(
      join(directory, "index.js"),
      `module.exports = { fixture: ${JSON.stringify(name)} };`,
    );
  }

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const support = require(${JSON.stringify(fileURLToPath(new URL("./html2pdf-render-support.js", import.meta.url)))});
       console.log(JSON.stringify([support.loadPlaywright().fixture, support.loadPdfLib().fixture]));`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: join(root, "node_modules"), PLAYWRIGHT_PATH: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ["playwright", "pdf-lib"]);
});

test("pdf-plugin keeps the optional HTML tools out of installed dependencies", async () => {
  // 约定：playwright/pdf-lib 只能作为外部可选工具，不进入生产/可选/开发依赖；若将来声明为 peer，
  // 必须同时标记 optional，避免包管理器把它当必装依赖或凭空限定已测版本范围。
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "devDependencies"])
    for (const name of ["playwright", "pdf-lib"])
      assert.equal(pkg[field]?.[name], undefined, `${field} 不能声明外部可选工具 ${name}`);
  for (const name of ["playwright", "pdf-lib"])
    if (pkg.peerDependencies?.[name] !== undefined)
      assert.equal(
        pkg.peerDependenciesMeta?.[name]?.optional,
        true,
        `${name} 若声明为 peer 必须 optional: true`,
      );
});

test("CLI help remains available without Playwright or a browser", () => {
  for (const script of ["html2pdf-next.js", "html2poster.js"]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`./${script}`, import.meta.url)), "--help"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: node/);
  }
});
