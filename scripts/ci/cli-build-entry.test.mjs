// CLI 的 esbuild build 入口与 knip 入口必须是同一条真实路径。
// 这个守卫防止两种回退：build 改成动态/相对路径导致入口漂移，或 knip 用 `src/**`
// 之类的宽 glob 把整个 CLI 源码树伪装成入口来消诊断。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cliRoot = join(root, "apps/zcode-cli/packages/cli");
const readRepoFile = (path) => readFile(join(root, path), "utf8");
const readRepoJson = async (path) => JSON.parse(await readRepoFile(path));

test("the real esbuild build entry is src/main.ts", async () => {
  const buildScript = await readRepoFile("apps/zcode-cli/packages/cli/scripts/build.mjs");
  assert.match(
    buildScript,
    /entryPoints:\s*\[resolve\(cliDirectory, "src\/main\.ts"\)\]/u,
    "build.mjs 必须以 src/main.ts 作为唯一 bundle 入口",
  );
  assert.ok(existsSync(join(cliRoot, "src/main.ts")), "src/main.ts 必须存在");
});

test("office public subpaths resolve before the generic shared build alias", async () => {
  const { resolveBuildAliases } =
    await import("../../apps/zcode-cli/packages/cli/scripts/build.mjs");
  const { build } = await import("esbuild");
  const manifest = await readRepoJson("packages/shared/package.json");
  const aliases = resolveBuildAliases();
  for (const subpath of ["office-viewer-assets", "office-viewer-assets-contract"]) {
    const key = `@zcode/shared/${subpath}`;
    assert.equal(aliases[key], join(root, "packages/shared", manifest.exports[`./${subpath}`]));
    assert.ok(Object.keys(aliases).indexOf(key) < Object.keys(aliases).indexOf("@zcode/shared"));
  }
  const result = await build({
    stdin: {
      contents:
        'import * as node from "@zcode/shared/office-viewer-assets"; import * as contract from "@zcode/shared/office-viewer-assets-contract"; console.log(node, contract);',
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    write: false,
    alias: aliases,
    metafile: true,
  });
  assert.ok(
    Object.keys(result.metafile.inputs).some((file) => file.endsWith("officeViewerAssetsNode.ts")),
  );
  assert.ok(
    Object.keys(result.metafile.inputs).some((file) => file.endsWith("officeViewerAssets.ts")),
  );
});

test("knip declares explicit CLI entries instead of a source glob", async () => {
  const config = await readRepoJson("knip.json");
  const workspace = config.workspaces?.["apps/zcode-cli/packages/cli"];
  assert.ok(workspace, "knip.json 必须为 CLI 声明 workspace");
  assert.deepEqual(
    [...workspace.entry].sort(),
    ["src/index.ts", "src/main.ts"],
    "CLI 只登记 build 入口 src/main.ts 与程序化 API port src/index.ts",
  );
  for (const entry of workspace.entry) {
    assert.ok(!entry.includes("*"), `CLI entry 不能使用 glob：${entry}`);
    assert.ok(existsSync(join(cliRoot, entry)), `CLI entry 必须是真实文件：${entry}`);
  }
  // src/index.ts 是真实 public port：仍从 run 模块导出可执行的 run。
  const indexSource = await readRepoFile("apps/zcode-cli/packages/cli/src/index.ts");
  assert.match(indexSource, /export \{ run \} from "\.\/run\.js";/u);
});
