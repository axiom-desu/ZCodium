// 冷 runner 依赖序守卫：本地残留 dist 会把「root workspace 的前置包没构建」藏起来，
// 之前两处 CI 冷构建（oracle deps 的 tsc、remote assets 的 esbuild）就因此变红。
// 这里锁定推导结果、冷态标记与每个消费者的调用顺序，不跑真实构建（避免并行删共享 dist），
// 也不删除/改写 packages/session-control/dist。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  missingArtifacts,
  resolveWorkspacePrerequisites,
} from "./build-workspace-prerequisites.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readRepoFile = (path) => readFileSync(join(root, path), "utf8");
const readRepoJson = (path) => JSON.parse(readRepoFile(path));
const SESSION_CONTROL = "@zcode/session-control";

test("只有根 workspace 的 dist 导出包进入前置清单，CLI turbo 图内的包不重复构建", () => {
  const prerequisites = resolveWorkspacePrerequisites();
  assert.deepEqual(
    prerequisites.map((pkg) => pkg.name),
    [SESSION_CONTROL],
  );
  // 消费者证明这不是无用的声明：CLI core 的 tsc 与 services 的 esbuild 都直接 import 它。
  assert.deepEqual(prerequisites[0].dependents, [
    "@zcode/bootstrap",
    "@zcode/core",
    "@zcode/services",
    "@zcode/shared",
  ]);
  assert.equal(prerequisites[0].build, "tsc");
});

test("dist 产物不入库，因此冷 runner 必然缺前置产物", () => {
  const ignored = spawnSync(
    "git",
    ["check-ignore", "-q", "packages/session-control/dist/contract.js"],
    {
      cwd: root,
    },
  );
  assert.equal(ignored.status, 0, "dist 必须被 .gitignore 忽略，否则冷构建无从谈起");
  const tracked = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "packages/session-control/dist/contract.js"],
    {
      cwd: root,
    },
  );
  assert.notEqual(tracked.status, 0, "构建产物不能入库替代构建");
});

test("冷态判据在缺产物时报缺、补齐后归零", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "zcode-prerequisites-"));
  try {
    mkdirSync(join(fixtureRoot, "packages/session-control"), { recursive: true });
    mkdirSync(join(fixtureRoot, "packages/consumer"), { recursive: true });
    writeFileSync(join(fixtureRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const manifest = readRepoJson("packages/session-control/package.json");
    writeFileSync(
      join(fixtureRoot, "packages/session-control/package.json"),
      JSON.stringify(manifest, null, 2),
    );
    writeFileSync(
      join(fixtureRoot, "packages/consumer/package.json"),
      JSON.stringify({
        name: "@zcode/consumer",
        private: true,
        dependencies: { [SESSION_CONTROL]: "workspace:*" },
      }),
    );

    const [prerequisite] = resolveWorkspacePrerequisites({ root: fixtureRoot });
    assert.equal(prerequisite.name, SESSION_CONTROL);
    // 这两个正是 CI 实际缺的入口：core 的 d.ts 与 server esbuild 的 JS。
    const missingBefore = missingArtifacts(prerequisite);
    assert.ok(missingBefore.includes("./dist/contract.js"));
    assert.ok(missingBefore.includes("./dist/application/app/index.js"));

    for (const target of new Set(prerequisite.entryTargets))
      mkdirSync(join(prerequisite.dir, target, ".."), { recursive: true });
    for (const target of new Set(prerequisite.entryTargets))
      writeFileSync(join(prerequisite.dir, target), "export {};\n");
    assert.deepEqual(missingArtifacts(prerequisite), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("每个消费者入口都先构建前置，再构建自己", () => {
  const scripts = readRepoJson("package.json").scripts;
  for (const name of [
    "build:zcode-cli-rust-oracle-deps",
    "build:zcode-cli-agent-deps",
    "build:bootstrap",
  ]) {
    assert.match(
      scripts[name],
      /^pnpm build:workspace-prerequisites && /u,
      `${name} 必须以前置构建开头，否则冷 runner 会缺 session-control 产物`,
    );
  }

  const prepare = readRepoFile("scripts/prepare-prebuilds.mjs");
  assert.ok(
    prepare.indexOf("buildWorkspacePrerequisites({ root: rootDir })") <
      prepare.indexOf('["run", "build:remote"]'),
    "prepare-prebuilds 必须在 server build:remote 之前构建根 workspace 前置",
  );

  // desktop agent / remote agent bundle 都经这份显式清单构建 CLI 依赖（@zcode/core 在清单里，
  // 但根 session-control 不在），所以同一前置必须排在 repo 级构建之前。
  const agentBuild = readRepoFile("scripts/build-desktop-agent-cli.mjs");
  assert.ok(
    agentBuild.indexOf("buildWorkspacePrerequisites({ root: repoRoot })") <
      agentBuild.indexOf("if (useBootstrapWithRemoteBuild)"),
    "build-desktop-agent-cli 的两条构建路径之前都要先构建前置",
  );

  const desktopWorkflow = readRepoFile(".github/workflows/desktop.yml");
  assert.match(desktopWorkflow, /run: pnpm build:zcode-cli-agent-deps/u);
  assert.ok(
    desktopWorkflow.indexOf("pnpm build:workspace-prerequisites") <
      desktopWorkflow.indexOf("pnpm --filter @zcode/desktop build:no-runtime-assets"),
    "desktop production build 之前必须构建前置",
  );

  const rustWorkflow = readRepoFile(".github/workflows/cli-rust.yml");
  for (const job of ["protocol-schema", "linux-node-interop"]) {
    const section = rustWorkflow.split(`  ${job}:`)[1]?.split(/\n {2}[a-z-]+:$/u)[0];
    assert.ok(section, `${job} job 必须存在`);
    assert.match(section, /pnpm build:zcode-cli-rust-oracle-deps/u);
  }
});

test("计划模式只输出顺序，不构建也不删除共享 dist", () => {
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/ci/build-workspace-prerequisites.mjs"), "--plan"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout).map((step) => step.name),
    [SESSION_CONTROL],
  );
  // 并行打包任务可能正在读同一份 dist：前置构建只能原地覆写，不能清理。
  const source = readRepoFile("scripts/ci/build-workspace-prerequisites.mjs");
  assert.doesNotMatch(source, /\b(?:rm|rmSync)\(|\bclean\b|--clean/u, "前置构建不能删除共享产物");
});

test("真实native与Web纵向有当前构建前置和CI执行者，不只依赖本地缓存", () => {
  const scripts = readRepoJson("package.json").scripts;
  assert.equal(
    scripts["test:services-safety"],
    "pnpm build:zcode-cli-rust && node scripts/ci/services-safety-tests.mjs",
  );
  const workflow = readRepoFile(".github/workflows/desktop.yml");
  const rustSetup = workflow.indexOf("uses: dtolnay/rust-toolchain@stable");
  const safety = workflow.indexOf("run: pnpm test:services-safety");
  assert.ok(rustSetup >= 0 && safety > rustSetup, "native纵向前必须安装Rust工具链");
  for (const name of ["test:extension-sessions-consent", "test:input-prediction"]) {
    assert.equal(typeof scripts[name], "string");
    assert.ok(workflow.includes(`pnpm ${name}`), `${name} 必须有实际CI执行者`);
  }
});
