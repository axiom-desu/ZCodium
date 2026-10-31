import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 桌面 node 侧产物必须保留 `node:` 前缀（spec：.agents/specs/desktop-bundle-node-builtins.md）。
// tsup 默认 removeNodeProtocol:true 会把 node:sqlite 改写成裸 `sqlite`，Electron 主进程在
// import 期就 `Cannot find package 'sqlite'` 退出，窗口根本不会出现。
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsupConfigPath = join(repoRoot, "packages/desktop/tsup.config.ts");
const outRoot = join(repoRoot, "packages/desktop/out");

/** 按 `name: "<target>"` 切分 config 块，便于逐个断言展开的共享选项。 */
function splitConfigBlocks(source) {
  const blocks = [];
  const matcher = /\n\s{4}name: "([^"]+)",/g;
  const marks = [...source.matchAll(matcher)].map((match) => ({
    name: match[1],
    index: match.index ?? 0,
  }));
  for (const [position, mark] of marks.entries()) {
    const end = marks[position + 1]?.index ?? source.length;
    blocks.push({ name: mark.name, text: source.slice(mark.index, end) });
  }
  return blocks;
}

test("所有 node 侧 tsup config 都关闭 node: 前缀剥离", async () => {
  const source = await readFile(tsupConfigPath, "utf8");

  assert.match(
    source,
    /desktopTsupNodeProtocolOptions\s*=\s*\{\s*removeNodeProtocol:\s*false\s*\}/,
    "tsup.config.ts 缺少 removeNodeProtocol:false 的共享常量",
  );

  const blocks = splitConfigBlocks(source);
  const nodeTargets = blocks.filter(
    (block) => /platform:\s*"node"/.test(block.text) && /format:\s*"(esm|cjs)"/.test(block.text),
  );
  assert.deepEqual(
    nodeTargets.map((block) => block.name).sort(),
    ["host", "main", "preload", "scheduler"],
    "node 侧 tsup config 集合变化，需同步确认 node: 前缀保留规则",
  );
  for (const block of nodeTargets) {
    assert.ok(
      block.text.includes("...desktopTsupNodeProtocolOptions"),
      `${block.name} config 未展开 desktopTsupNodeProtocolOptions`,
    );
  }
});

test("构建产物不包含被改写的裸 sqlite specifier", async (t) => {
  // Release tests 在桌面构建之前运行，产物缺失时只跑配置守卫。
  if (!existsSync(outRoot)) {
    t.skip("packages/desktop/out 不存在：本次只校验构建配置");
    return;
  }

  const offenders = [];
  for (const directory of ["main", "host", "scheduler", "preload"]) {
    const absolute = join(outRoot, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of await readdir(absolute)) {
      if (!entry.endsWith(".js") && !entry.endsWith(".cjs")) continue;
      const source = await readFile(join(absolute, entry), "utf8");
      // 只匹配裸名：`from"sqlite"`、`require("sqlite")`、`from 'sqlite'`。
      // `note:sqlite` 里出现的 `node:sqlite` 不算问题。
      const bare = source.match(/(?:from|import|require)\s*\(?\s*["']sqlite["']/g);
      if (bare) offenders.push(`${directory}/${entry}: ${bare.length}`);
    }
  }
  assert.deepEqual(offenders, [], `桌面产物仍在解析裸 sqlite 模块：${offenders.join(", ")}`);
});
