import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

// 直接解析真实工作流（公开入口），断言 job 条件与 needs 图语义，
// 而不是复制一份手写函数；工作流文件是唯一事实来源。
const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/desktop.yml");

async function loadJobs() {
  const document = parse(await readFile(workflowPath, "utf8"));
  return document.jobs;
}

const uses = (job, prefix) =>
  job.steps.filter((step) => String(step.uses ?? "").startsWith(prefix));

test("desktop workflow is valid YAML with the expected jobs", async () => {
  const jobs = await loadJobs();
  assert.deepEqual(Object.keys(jobs).sort(), [
    "build",
    "build-macos",
    "checks",
    "release",
    "remote-assets",
  ]);
});

test("remote assets start independently of checks and only gate on cancellation", async () => {
  const jobs = await loadJobs();
  const assets = jobs["remote-assets"];
  // coverage 不生产远端资产；不能让独立 producer 白等整段检查完成。
  assert.equal(assets.needs, undefined);
  assert.equal(String(assets.if).trim(), "${{ !cancelled() }}");
  // 明确不按 checks 的 success 结果门禁，否则 checks 红时资产 job 会被跳过。
  assert.doesNotMatch(String(assets.if), /needs\.checks\.result|success\(\)/);
  assert.equal(uses(assets, "actions/upload-artifact").length, 1);
});

test("build consumes real assets, not checks success, and never silently falls back", async () => {
  const jobs = await loadJobs();
  for (const id of ["build", "build-macos"]) {
    const job = jobs[id];
    assert.deepEqual(job.needs, "remote-assets");
    const condition = String(job.if);
    assert.match(condition, /!cancelled\(\)/);
    assert.match(condition, /needs\.remote-assets\.result == 'success'/);
    // 只看 assets 成功，不因 checks 失败跳过打包。
    assert.doesNotMatch(condition, /needs\.checks\.result/);
    const downloads = uses(job, "actions/download-artifact").filter(
      (step) => step.with?.name === "bundled-remote-linux-x64",
    );
    assert.equal(downloads.length, 1);
    for (const step of job.steps) {
      assert.notEqual(step["continue-on-error"], true);
      if (step.uses?.startsWith("actions/download-artifact"))
        assert.notEqual(step.with?.["if-no-files-found"], "ignore");
    }
  }
});

test("parallel packaging preserves coverage commands, full targets and current-run artifact ownership", async () => {
  const jobs = await loadJobs();
  const commands = jobs.checks.steps.map((step) => step.run ?? "").join("\n");
  for (const command of [
    "pnpm typecheck",
    "pnpm lint",
    "pnpm fmt:check",
    "pnpm architecture:check",
    "pnpm -r --filter './apps/zcode-cli/packages/*' test",
    "pnpm vitest run",
    "node --test --test-isolation=none scripts/ci/*.test.mjs",
    "node scripts/ci/remote-form-smoke.mjs",
    "node scripts/ci/web-remote-control-dialog-smoke.mjs",
  ]) {
    assert.ok(commands.includes(command), `missing coverage command: ${command}`);
  }
  for (const id of ["build", "build-macos"]) {
    const job = jobs[id];
    assert.equal(job.env?.ZCODE_DESKTOP_LINUX_TARGETS, undefined);
    for (const download of uses(job, "actions/download-artifact")) {
      assert.equal(download.with?.["run-id"], undefined);
      assert.equal(download.with?.repository, undefined);
    }
    const commands = job.steps.map((step) => step.run ?? "");
    const verify = commands.indexOf("node scripts/bundle-remote-assets.mjs verify");
    const prepare = commands.indexOf("pnpm prepare:desktop-runtime");
    const build = commands.indexOf("pnpm build:bootstrap");
    assert.ok(verify >= 0 && prepare > verify && build > prepare);
    assert.ok(commands.some((command) => command.includes("--skip-prepare --skip-build")));
  }
});

test("dual-product matrix expands four Exp jobs on PR/main and twelve jobs on dispatch/tag", async () => {
  const jobs = await loadJobs();
  const desktop = jobs.build;
  const matrix = desktop.strategy.matrix;
  assert.deepEqual(
    matrix.target.map(({ platform, arch }) => `${platform}-${arch}`),
    ["linux-x64", "linux-arm64", "win-x64", "win-arm64"],
  );
  assert.equal(
    matrix.flavor,
    "${{ fromJSON((github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref_type == 'tag')) && '[\"production\",\"preview\"]' || '[\"production\"]') }}",
  );
  assert.equal((await parse(await readFile(workflowPath, "utf8"))).env.ZCODE_ENV, "production");
  assert.equal(desktop.env?.ZCODE_ENV, undefined);
  assert.equal(desktop.env?.ZCODE_TARGET_OS, "${{ matrix.target.platform }}");
  assert.equal(desktop.env?.ZCODE_TARGET_ARCH, "${{ matrix.target.arch }}");
  assert.equal(
    desktop.env?.ZCODE_PREVIEW_IDENTITY,
    "${{ matrix.flavor == 'preview' && '1' || '0' }}",
  );
  assert.equal(desktop.strategy["fail-fast"], false);
  assert.ok(desktop.name.includes("matrix.flavor"));
  const mac = jobs["build-macos"];
  assert.equal(mac.strategy["fail-fast"], false);
  assert.deepEqual(
    mac.strategy.matrix.target.map(({ arch }) => arch),
    ["arm64", "x64"],
  );
  assert.match(String(mac.if), /workflow_dispatch/);
  assert.match(String(mac.if), /github\.event_name == 'push'.*github\.ref_type == 'tag'/);
  assert.equal(mac.env?.ZCODE_PREVIEW_IDENTITY, desktop.env.ZCODE_PREVIEW_IDENTITY);
});

test("actual event expressions expand to four daily or twelve dual-product jobs", async () => {
  const jobs = await loadJobs();
  for (const [event, refType, expected] of [
    ["pull_request", "branch", 4],
    ["push", "branch", 4],
    ["workflow_dispatch", "branch", 12],
    ["workflow_dispatch", "tag", 12],
    ["push", "tag", 12],
  ]) {
    const context = {
      github: { event_name: event, ref_type: refType },
      needs: { "remote-assets": { result: "success" } },
      cancelled: () => false,
    };
    const combinations = [];
    for (const id of ["build", "build-macos"]) {
      const job = jobs[id];
      // Actions 允许 job id 含横杠；映射到 JS 的方括号属性语法再求值。
      const condition = String(job.if)
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .replaceAll("needs.remote-assets", 'needs["remote-assets"]');
      const enabled = runInNewContext(condition, context, { timeout: 1000 });
      if (!enabled) continue;
      const expression = job.strategy.matrix.flavor.match(/^\$\{\{\s*fromJSON\((.*)\)\s*\}\}$/)[1];
      const flavors = JSON.parse(runInNewContext(expression, context, { timeout: 1000 }));
      for (const flavor of flavors)
        for (const target of job.strategy.matrix.target)
          combinations.push(`${flavor}/${target.platform ?? "mac"}/${target.arch}`);
    }
    assert.equal(combinations.length, expected, `${event}/${refType}`);
    assert.equal(new Set(combinations).size, expected);
    if (expected === 4) assert.ok(combinations.every((item) => item.startsWith("production/")));
    else assert.equal(combinations.filter((item) => item.startsWith("preview/")).length, 6);
  }
});

test("preview toolchains precede preparation and Windows arm64 initializes matching MSVC", async () => {
  const jobs = await loadJobs();
  for (const id of ["build", "build-macos"]) {
    const job = jobs[id];
    const rust = job.steps.findIndex((step) =>
      String(step.uses ?? "").startsWith("dtolnay/rust-toolchain@"),
    );
    const prepare = job.steps.findIndex((step) => step.name === "Prepare desktop runtime");
    assert.ok(
      rust >= 0 && prepare > rust,
      `${id}: Rust toolchain must be installed before runtime preparation`,
    );
    assert.match(String(job.steps[rust].if), /matrix\.flavor == 'preview'/);
  }
  const windows = jobs.build.steps.findIndex((step) =>
    String(step.uses ?? "").startsWith("ilammy/msvc-dev-cmd@"),
  );
  const prepare = jobs.build.steps.findIndex((step) => step.name === "Prepare desktop runtime");
  assert.ok(windows >= 0 && prepare > windows);
  assert.equal(
    jobs.build.steps[windows].uses,
    "ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756",
  );
  assert.match(
    String(jobs.build.steps[windows].if),
    /matrix\.flavor == 'preview'.*matrix\.target\.platform == 'win'/,
  );
  assert.match(
    jobs.build.steps[windows].with.arch,
    /matrix\.target\.arch == 'arm64'.*amd64_arm64.*amd64/,
  );
  const rustTarget = jobs.build.steps.findIndex((step) =>
    String(step.run ?? "").includes("rustup target add aarch64-pc-windows-msvc"),
  );
  assert.ok(rustTarget >= 0 && rustTarget < prepare);
  assert.match(String(jobs.build.steps[rustTarget].if), /matrix\.target\.arch == 'arm64'/);
});

test("release downloads exactly the twelve flavor/platform/arch artifacts", async () => {
  const jobs = await loadJobs();
  const names = uses(jobs.release, "actions/download-artifact").map((step) => step.with.name);
  const expected = ["production", "preview"].flatMap((flavor) => [
    `desktop-${flavor}-linux-x64`,
    `desktop-${flavor}-linux-arm64`,
    `desktop-${flavor}-win-x64`,
    `desktop-${flavor}-win-arm64`,
    `desktop-${flavor}-mac-arm64`,
    `desktop-${flavor}-mac-x64`,
  ]);
  assert.equal(names.length, 12);
  assert.deepEqual([...names].sort(), [...expected].sort());
  assert.equal(new Set(names).size, 12);
});

test("release still requires checks success before publishing a draft", async () => {
  const jobs = await loadJobs();
  const release = jobs.release;
  // 默认 needs 语义要求全部 needs success；checks 在列表内即发布 guard。
  assert.deepEqual(release.needs, ["checks", "build", "build-macos"]);
  assert.equal(release.if, "github.event_name == 'push' && github.ref_type == 'tag'");
  assert.equal(release["continue-on-error"], undefined);
});
