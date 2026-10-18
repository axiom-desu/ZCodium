import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
const root = resolve(import.meta.dirname, "../..");
async function load(path) {
  // CI 多套 Node 测试共享进程；纯展示入口独立编译，不能注册全局 TS loader 改变其它套件的解析。
  const { outputFiles } = await build({
    entryPoints: [resolve(root, path)],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
  );
}

test("public locale copy brands help and terminal startup as ZCodium without renaming protocol", async () => {
  const { getZCodeCopy } = await load("apps/zcode-cli/packages/i18n/src/index.ts");
  for (const locale of ["en-US", "zh-CN"]) {
    const copy = getZCodeCopy(locale);
    assert.match(copy.cli.help("1.2.3"), /^ZCodium CLI 1\.2\.3/);
    assert.match(copy.cli.help("1.2.3"), /ZCode Protocol/);
    assert.match(copy.cli.help("1.2.3"), /zcode \[command\]/);
    assert.match(copy.tui.terminal.starting, /ZCodium/);
  }
});

test("new ZCODIUM Mark uses all seven letters and fits the available terminal pane", async () => {
  const { logoLinesForWidth, ZCODIUM_LOGO_LINES } = await load(
    "apps/zcode-cli/packages/tui/src/app-logo.ts",
  );
  assert.equal(ZCODIUM_LOGO_LINES.length, 6);
  assert.ok(ZCODIUM_LOGO_LINES[0].endsWith("███╗   ███╗"));
  const width = Math.max(...ZCODIUM_LOGO_LINES.map((line) => line.length));
  assert.deepEqual(logoLinesForWidth(width), ZCODIUM_LOGO_LINES);
  assert.deepEqual(logoLinesForWidth(width - 1), ["ZCodium"]);
  for (const available of [0, 6, 7, 20, 40, 60, 120]) {
    for (const line of logoLinesForWidth(available)) assert.ok(line.length <= available);
  }
});
