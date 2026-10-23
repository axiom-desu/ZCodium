// PDF skill 的渲染 CLI（html2pdf-next.js / html2poster.js / cover_validate.js）按需依赖
// playwright / pdf-lib，因此它以一个真实独立的 CommonJS 工具包身份存在：
// 自带 package.json + 普通 peer requirements，但**不是** pnpm workspace 成员——root 安装图、
// lockfile importer 与 SEA 分发都不该被它牵连。这些 peer 是用户显式选择该工具后的环境前提，
// 既不是 optional peer（knip 会把被引用的 optional peer 判为不一致），也不是 root 依赖。
// 本测试锁定这条边界，避免以后有人把它挪进 `apps/zcode-cli/packages/*` 别名、
// 或改回 root 依赖 / ignoreDependencies 来消 knip。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BUILTIN_PLUGIN_SEED_PATHS } from "../../packages/shared/src/builtinPluginAssets.ts";

const TOOL_DIR = "apps/zcode-cli/packages/pdf-plugin/skills/pdf/scripts";

// 只支持 workspace 清单实际用到的 glob 语义（`*` 不跨 `/`，`**` 跨层级），
// 不为了一个断言引入新的依赖或复用未声明的传递包。
const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .split("/")
      .map((segment) =>
        segment === "**"
          ? ".*"
          : segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*"),
      )
      .join("/")}$`,
    "u",
  );

const readRepoFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const readRepoJson = async (path) => JSON.parse(await readRepoFile(path));

test("standalone tool manifest declares external tools as plain peer requirements", async () => {
  const pkg = await readRepoJson(`${TOOL_DIR}/package.json`);
  assert.equal(pkg.name, "@zcode/pdf-render-tool");
  assert.equal(pkg.version, "0.0.0");
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "Apache-2.0");
  // 既有 CLI 本来就是 CommonJS；带 type 的 manifest 不能改变 Node 的加载模式。
  assert.equal(pkg.type, "commonjs");
  for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
    assert.equal(pkg[field], undefined, `${field} 会让工具用户 cd 进来安装时被动拉包`);
  }
  // 普通 peer 是「显式选择该工具后的环境前提」：不标 optional。
  // 标 optional 会让 knip 对已引用的 optional peer 报不一致，只能靠基线/ignore 掩盖。
  assert.equal(
    pkg.peerDependenciesMeta,
    undefined,
    "不声明 peerDependenciesMeta：这些 peer 是显式选择工具环境后的前提，不是可选残留",
  );
  for (const name of ["playwright", "playwright-core", "pdf-lib"]) {
    assert.equal(pkg.peerDependencies?.[name], "*", `${name} 必须作为普通 peer 声明`);
  }
});

test("root pnpm workspace and lockfile importers do not own the nested tool project", async () => {
  const workspaceYaml = await readRepoFile("pnpm-workspace.yaml");
  const patterns = workspaceYaml
    .split("\n")
    .map((line) => line.match(/^\s*-\s*(\S+)\s*$/)?.[1])
    .filter(Boolean)
    .map((pattern) => pattern.replace(/^\.\//, ""));
  assert.ok(patterns.length > 0, "pnpm-workspace.yaml 应至少声明一个 workspace glob");
  const matched = patterns.filter((pattern) => globToRegExp(pattern).test(TOOL_DIR));
  assert.deepEqual(
    matched,
    [],
    `${TOOL_DIR} 不能被 pnpm workspace glob 命中：一旦成为 workspace 成员，root autoInstallPeers 会为工作区自身安装 optional peers`,
  );
  // 正向对照：同一套匹配必须能识别父插件的 workspace 归属，否则上面的空数组毫无意义。
  assert.ok(
    patterns.some((pattern) => globToRegExp(pattern).test("apps/zcode-cli/packages/pdf-plugin")),
    "workspace glob 匹配器应能命中 apps/zcode-cli/packages/pdf-plugin",
  );

  // lockfile 是 root 安装图的真值：嵌套工具目录不允许出现 importer。
  const lock = await readRepoFile("pnpm-lock.yaml");
  assert.doesNotMatch(
    lock,
    new RegExp(`^\\s{2}${TOOL_DIR}:`, "mu"),
    "pnpm-lock.yaml 不能为嵌套工具目录生成 importer",
  );

  // 外层插件清单保持原样：工具依赖不属于插件 workspace。
  const pluginPkg = await readRepoJson("apps/zcode-cli/packages/pdf-plugin/package.json");
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "devDependencies",
    "peerDependencies",
  ]) {
    assert.equal(pluginPkg[field], undefined, `pdf-plugin 的 ${field} 必须保持为空`);
  }

  // Root app 选择这些外部工具是可选行为：root 清单不得把它们变成安装前提。
  const rootPkg = await readRepoJson("package.json");
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "devDependencies",
    "peerDependencies",
  ]) {
    for (const name of ["playwright", "playwright-core", "pdf-lib"]) {
      assert.equal(
        rootPkg[field]?.[name],
        undefined,
        `root 的 ${field} 不能声明 ${name}：只由显式进入 standalone project 的用户安装`,
      );
    }
  }
});

test("knip registers the nested tool as its own project instead of the outer plugin workspace", async () => {
  const config = await readRepoJson("knip.json");
  const inline = config.workspaces?.[TOOL_DIR];
  assert.ok(inline, `knip.json 必须把 ${TOOL_DIR} 登记为独立 project`);
  assert.deepEqual(
    [...inline.entry].sort(),
    ["cover_validate.js", "html2pdf-next.js", "html2poster.js"],
    "entry 只登记该工具的 3 个真实 CLI 入口",
  );
  assert.equal(
    config.workspaces["apps/zcode-cli/packages/pdf-plugin"],
    undefined,
    "外层插件 workspace 不能再登记 entry，否则脚本会被错误 scope 到父项目",
  );
});

test("the bundled pdf-plugin seed list ships the standalone tool manifest", async () => {
  const seeds = BUILTIN_PLUGIN_SEED_PATHS["pdf-plugin"];
  assert.ok(
    seeds.includes("skills/pdf/scripts/package.json"),
    "standalone manifest 必须进入分发种子",
  );
  for (const script of ["cover_validate.js", "html2pdf-next.js", "html2poster.js"]) {
    assert.ok(seeds.includes(`skills/pdf/scripts/${script}`), `${script} 必须仍在种子清单里`);
  }
});

test("knip resolves the standalone project with no issues at all", async () => {
  // 归属证明：只有把该目录当成独立 project，playwright/pdf-lib 才会被图上的
  // 普通 peer 认领，而不是落到 root/父插件 workspace 报 unlisted。
  const knipBin = new URL("../../node_modules/knip/bin/knip.js", import.meta.url).pathname;
  const result = spawnSync(
    process.execPath,
    [knipBin, "--reporter", "json", "--no-config-hints", "--workspace", TOOL_DIR],
    { encoding: "utf8", timeout: 240_000 },
  );
  const issues = (() => {
    try {
      return JSON.parse(result.stdout).issues;
    } catch {
      assert.fail(`knip 没有输出 JSON 报告：\n${result.stdout}\n${result.stderr}`);
    }
  })();
  const relevant = issues.filter((issue) => issue.file.startsWith(TOOL_DIR));
  // 普通 peer 后该 project 必须完全干净：不只是 unlisted/unused-file，
  // 也包括 optionalPeerDependencies 之类的告警，不能用排除项迁就。
  assert.deepEqual(
    relevant,
    [],
    `standalone project 不应有任何 knip issue：${JSON.stringify(relevant, null, 2)}`,
  );
});
