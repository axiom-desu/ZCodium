import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { supportedTargets } from "../../apps/zcode-cli/packages/cli/scripts/sea-targets.mjs";
import { opentuiNativePackageForTarget } from "../../apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs";
import {
  resolveDesktopCliTuiTarget,
  stageDesktopCliTui,
  verifyDesktopCliAssets,
} from "../../packages/desktop/scripts/stage-desktop-cli-tui.mjs";
import { stageAgentBundle } from "../../packages/desktop/scripts/stage-agent-bundle.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("desktop TUI targets map all supported native packages to release platform names", () => {
  assert.deepEqual(supportedTargets, [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win-arm64",
    "win-x64",
  ]);
  assert.deepEqual(
    supportedTargets.map((target) => [target, opentuiNativePackageForTarget(target)]),
    [
      ["darwin-arm64", "@mbears/opentui-core-darwin-arm64"],
      ["darwin-x64", "@mbears/opentui-core-darwin-x64"],
      ["linux-arm64", "@mbears/opentui-core-linux-arm64"],
      ["linux-x64", "@mbears/opentui-core-linux-x64"],
      ["win-arm64", "@mbears/opentui-core-win32-arm64"],
      ["win-x64", "@mbears/opentui-core-win32-x64"],
    ],
  );
});

test("desktop paths retain win32 keys while SEA native targets use win", () => {
  assert.deepEqual(resolveDesktopCliTuiTarget("win32-arm64"), {
    target: "win-arm64",
    desktopKey: "win32-arm64",
  });
  assert.deepEqual(resolveDesktopCliTuiTarget("win-x64"), {
    target: "win-x64",
    desktopKey: "win32-x64",
  });
  assert.throws(() => resolveDesktopCliTuiTarget("linux-riscv64"));
});

test("public CLI stages provider sidecar and notices beside the bundle", async (t) => {
  const temp = await mkdtemp(resolve(tmpdir(), "desktop-cli-provider-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dist = resolve(temp, "apps/zcode-cli/packages/cli/dist");
  await mkdir(resolve(dist, "provider"), { recursive: true });
  await writeFile(resolve(dist, "zcode.cjs"), "// cli");
  await writeFile(resolve(dist, "provider/zcode-builtin.json"), '{"fixture":true}');
  await writeFile(resolve(dist, "THIRD-PARTY-NOTICES.md"), "notices");
  const staged = await stageAgentBundle({
    repoRoot: temp,
    platformKey: "linux-x64",
    log: () => {},
  });
  const parent = resolve(staged.stagedBundlePath, "..");
  assert.equal(
    await readFile(resolve(parent, "provider/zcode-builtin.json"), "utf8"),
    '{"fixture":true}',
  );
  assert.equal(await readFile(resolve(parent, "THIRD-PARTY-NOTICES.md"), "utf8"), "notices");
});

test("packaged Windows asset validation rejects dropped native dependencies and wrong targets", async (t) => {
  const glmDir = await mkdtemp(resolve(tmpdir(), "desktop-cli-packaged-"));
  t.after(() => rm(glmDir, { recursive: true, force: true }));
  const files = [
    "node_modules/@zcode/tui/dist/index.js",
    "node_modules/@mbears/opentui-core-win32-arm64/opentui.dll",
  ];
  const manifest = { version: 1, target: "win-arm64", files: files.map((path) => ({ path })) };
  for (const path of [
    "zcode.cjs",
    "provider/zcode-builtin.json",
    "THIRD-PARTY-NOTICES.md",
    ...files,
  ]) {
    await mkdir(resolve(glmDir, path, ".."), { recursive: true });
    await writeFile(resolve(glmDir, path), "fixture");
  }
  await writeFile(resolve(glmDir, "tui-manifest.json"), JSON.stringify(manifest));
  await verifyDesktopCliAssets({ glmDir, platformKey: "win32-arm64" });
  await rm(resolve(glmDir, files[1]));
  await assert.rejects(verifyDesktopCliAssets({ glmDir, platformKey: "win32-arm64" }), /ENOENT/);
  await assert.rejects(
    verifyDesktopCliAssets({ glmDir, platformKey: "linux-x64" }),
    /wrong platform/,
  );
});

test("a missing runtime manifest fails cleanly without leaving partial TUI assets", async (t) => {
  const tempRoot = await mkdtemp(resolve(tmpdir(), "zcode-desktop-tui-failure-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const glm = resolve(tempRoot, "packages/desktop/bundled-agents/linux-x64/glm");
  const sourceRoot = resolve(tempRoot, "source");
  await mkdir(resolve(glm, "node_modules/old-runtime"), { recursive: true });
  await mkdir(resolve(sourceRoot, "packages/tui/dist"), { recursive: true });
  await writeFile(resolve(sourceRoot, "packages/tui/dist/index.js"), "");
  await assert.rejects(
    stageDesktopCliTui({ repoRoot: tempRoot, sourceRoot, platformKey: "linux-x64", log: () => {} }),
    /runtime-dependencies/,
  );
  await assert.rejects(access(resolve(glm, "node_modules")), { code: "ENOENT" });
  await assert.rejects(access(resolve(glm, "tui-manifest.json")), { code: "ENOENT" });
});

test("clean target stage imports the real @zcode/tui using Electron Node", async (t) => {
  const target = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  assert.ok(supportedTargets.includes(target), `Unsupported host test target: ${target}`);
  const electron = resolve(
    root,
    "node_modules/electron/dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );
  try {
    await access(electron);
  } catch {
    t.skip("Electron executable is unavailable for Electron-Node asset smoke test");
    return;
  }
  const tempRoot = await mkdtemp(resolve(tmpdir(), "zcode-desktop-tui-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  await mkdir(resolve(tempRoot, "packages/desktop"), { recursive: true });
  const staged = await stageDesktopCliTui({
    repoRoot: tempRoot,
    sourceRoot: resolve(root, "apps/zcode-cli"),
    platformKey: target,
    log: () => {},
  });
  const importSource = `import { runTui } from ${JSON.stringify(resolve(staged.destination, "@zcode/tui/dist/index.js"))}; if (typeof runTui !== "function") throw new Error("Missing runTui"); process.stdout.write("desktop-tui-ok");`;
  const child = spawn(electron, ["--eval", importSource], {
    cwd: tempRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /desktop-tui-ok/);
  assert.equal(stdout.includes(root), false, "TUI runtime resolved through repository paths");
  const stagedManifest = JSON.parse(await readFile(staged.manifestPath, "utf8"));
  assert.equal(stagedManifest.schema, 1);
  assert.ok(Array.isArray(stagedManifest.runtimeDependencies));
  assert.ok(stagedManifest.runtimeDependencies.every((name) => !name.startsWith("@zcode/")));
  const builtRuntimeManifest = JSON.parse(
    await readFile(
      resolve(root, "apps/zcode-cli/packages/tui/dist/runtime-dependencies.json"),
      "utf8",
    ),
  );
  assert.deepEqual(stagedManifest.runtimeDependencies, builtRuntimeManifest.externalDependencies);
  const stagedPackage = JSON.parse(
    await readFile(resolve(staged.destination, "@zcode/tui/package.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(stagedPackage.dependencies).sort(),
    builtRuntimeManifest.externalDependencies,
  );
  assert.ok(
    stagedManifest.files.every(({ path }) => !/\.tsx?$|\.d\.ts$|\.map$/.test(path)),
    `staged runtime contains TypeScript or source maps: ${stagedManifest.files
      .map(({ path }) => path)
      .filter((path) => /\.tsx?$|\.d\.ts$|\.map$/.test(path))
      .join(", ")}`,
  );
  const nativePackages = stagedManifest.files
    .map(
      ({ path }) => path.match(/node_modules\/@mbears\/opentui-core-([^/]+)\/package\.json/)?.[1],
    )
    .filter(Boolean);
  assert.deepEqual(nativePackages, [
    opentuiNativePackageForTarget(target).replace("@mbears/opentui-core-", ""),
  ]);
});
