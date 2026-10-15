import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRuntimeAssetsPlan } from "../../packages/desktop/scripts/runtime-assets-plan.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const prepareRuntimeAssetsScript = join(
  repoRoot,
  "packages/desktop/scripts/prepare-runtime-assets.mjs",
);
const electronBuilderConfig = join(repoRoot, "packages/desktop/electron-builder.config.js");

/**
 * 随包 Rust 资产矩阵的单一事实来源。
 *
 * 有效产品 flavor = loadBuiltinProviderConfig().environment + process.env，
 * 与 tsup 的 __ZCODE_PRODUCT_FLAVOR__、electron-builder 的 productName/appId 同源：
 * - production 且无 preview 身份开关 → production（不带 Rust）；
 * - production + ZCODE_PREVIEW_IDENTITY=1 → preview（带 Rust）；
 * - test 无论 preview 开关取值都是 preview（ZCodium Rust），必须带 Rust。
 */
const ASSET_MATRIX = [
  {
    label: "production 默认（无 preview 身份开关）不随包 Rust",
    zcodeEnv: "production",
    previewIdentity: undefined,
    includeRust: false,
  },
  {
    label: "production + ZCODE_PREVIEW_IDENTITY=1 随包 Rust",
    zcodeEnv: "production",
    previewIdentity: "1",
    includeRust: true,
  },
  {
    label: "test + ZCODE_PREVIEW_IDENTITY=0 也随包 Rust",
    zcodeEnv: "test",
    previewIdentity: "0",
    includeRust: true,
  },
  {
    label: "test + ZCODE_PREVIEW_IDENTITY=1 随包 Rust",
    zcodeEnv: "test",
    previewIdentity: "1",
    includeRust: true,
  },
];

/** 构造场景 env：显式清掉继承的 preview 开关，避免宿主环境把用例污染成另一种口味。 */
function buildScenarioEnv(scenario) {
  const env = { ...process.env, ZCODE_ENV: scenario.zcodeEnv };
  if (scenario.previewIdentity === undefined) {
    delete env.ZCODE_PREVIEW_IDENTITY;
  } else {
    env.ZCODE_PREVIEW_IDENTITY = scenario.previewIdentity;
  }
  return env;
}

function scenarioPlanInput(scenario) {
  return {
    environment: scenario.zcodeEnv,
    env:
      scenario.previewIdentity === undefined
        ? {}
        : { ZCODE_PREVIEW_IDENTITY: scenario.previewIdentity },
  };
}

test("runtime-assets plan 保留 env 环境，显式有效配置优先", () => {
  assert.equal(
    resolveRuntimeAssetsPlan({ env: { ZCODE_ENV: "production" } }).includeRustCliRuntime,
    false,
  );
  assert.equal(
    resolveRuntimeAssetsPlan({
      environment: "test",
      env: { ZCODE_ENV: "production" },
    }).includeRustCliRuntime,
    true,
  );
});

for (const scenario of ASSET_MATRIX) {
  test(`runtime-assets plan：${scenario.label}`, () => {
    const plan = resolveRuntimeAssetsPlan(scenarioPlanInput(scenario));
    assert.equal(plan.includeRustCliRuntime, scenario.includeRust);
    assert.equal(plan.productFlavor, scenario.includeRust ? "preview" : "production");
  });
}

/**
 * 在临时目录里放一个假 pnpm，把 prepare:runtime-assets 真实调用的脚本名写进日志。
 * 这样验证的是脚本实际的命令选择，而不是源码字符串扫描。
 */
async function createStubPnpm(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), "zcode-runtime-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const logPath = join(root, "pnpm-invocations.log");
  const posixStub = join(binDir, "pnpm");
  await writeFile(
    posixStub,
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$ZCODE_STUB_PNPM_LOG"\n',
    "utf8",
  );
  await chmod(posixStub, 0o755);
  // Windows 上 runCommand 会把 bare pnpm 交给 cmd shim 解析。
  await writeFile(join(binDir, "pnpm.cmd"), '@echo %*>>"%ZCODE_STUB_PNPM_LOG%"\r\n', "utf8");

  const childEnv = {
    ...buildScenarioEnv(scenario),
    // 顺序用例外显式打开 remote-assets，避免 CI 的 ZCODE_SKIP_REMOTE_ASSETS=1 让断言失去对象。
    ZCODE_SKIP_REMOTE_ASSETS: "0",
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    ZCODE_STUB_PNPM_LOG: logPath,
  };
  return { childEnv, logPath };
}

async function readInvocations(logPath) {
  try {
    return (await readFile(logPath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

for (const scenario of ASSET_MATRIX) {
  test(`prepare:runtime-assets 实际命令选择：${scenario.label}`, async (t) => {
    const { childEnv, logPath } = await createStubPnpm(t, scenario);
    const { stderr } = await execFileAsync(process.execPath, [prepareRuntimeAssetsScript], {
      cwd: repoRoot,
      env: childEnv,
      maxBuffer: 32 * 1024 * 1024,
    });
    const invoked = await readInvocations(logPath);
    const detail = `invoked=[${invoked.join(", ")}] stderr=${stderr}`;

    assert.equal(invoked.includes("prepare:cli-rust"), scenario.includeRust, detail);
    // 版本缓存必须仍先于所有带版本戳的资产落盘，重构不能回退既有顺序。
    assert.equal(invoked[0], "prepare:build-meta", detail);
    assert.ok(
      invoked.indexOf("prepare:remote-assets") > invoked.indexOf("prepare:build-meta"),
      detail,
    );
  });
}

/**
 * 直接加载真实 electron-builder 配置，断言 extraResources 的 rust 条目跟随有效 flavor。
 * 每个场景独立子进程，避免 ESM 模块缓存把 process.env 固定成第一次导入的取值。
 */
async function readExtraResourceTargets(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), "zcode-builder-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probePath = join(root, "probe.mjs");
  await writeFile(
    probePath,
    [
      `const { default: config } = await import(${JSON.stringify(pathToFileURL(electronBuilderConfig).href)});`,
      `process.stdout.write("ZCODE_EXTRA_RESOURCES=" + JSON.stringify(config.extraResources.map((entry) => entry.to)) + "\\n");`,
    ].join("\n"),
    "utf8",
  );
  const { stdout } = await execFileAsync(process.execPath, [probePath], {
    cwd: repoRoot,
    env: buildScenarioEnv(scenario),
    maxBuffer: 16 * 1024 * 1024,
  });
  const match = stdout.match(/ZCODE_EXTRA_RESOURCES=(\[.*\])/);
  assert.ok(match, `electron-builder.config.js 未输出 extraResources：${stdout}`);
  return JSON.parse(match[1]);
}

for (const scenario of ASSET_MATRIX) {
  test(`electron-builder extraResources 资产矩阵：${scenario.label}`, async (t) => {
    const targets = await readExtraResourceTargets(t, scenario);
    assert.equal(
      targets.includes("rust"),
      scenario.includeRust,
      `extraResources=${targets.join(", ")}`,
    );
    // glm JS bundle 是所有口味共用的锚点，确认只增删 rust 而不动其他随包资产。
    assert.ok(targets.includes("glm"));
  });
}
