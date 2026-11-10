import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import test from "node:test";
import { bundleRemoteAssets, verifyBundledRemoteAssets } from "../bundle-remote-assets.mjs";
import { prepareSourceServerRelease } from "../prepare-source-server-release.mjs";
import { createPreparedSourceServerFixture } from "./sourceServerPreparedFixture.mjs";
import { createRemoteAssetFixture } from "./remoteAssetsFixture.mjs";

const run = promisify(execFile);
const { resolveSourceServerReleaseAsset, resolveSourceServerReleaseRuntimeOptions } =
  await tsImport("../../packages/desktop/src/host/sourceServerReleaseResolver.ts", import.meta.url);
const prepare = resolve(import.meta.dirname, "../prepare-prebuilds.mjs");
const { resolveHostTarCommand } = await tsImport(
  "../../packages/zcode-server-cli/src/packaging/tarCommand.ts",
  import.meta.url,
);

function isolatedEnv(root) {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    ZCODE_DATA_BASE_DIR: join(root, "data"),
  };
}

// 真正执行公开入口、既有 stageRelease 与 tar；fixture 仅用于依赖形状，不冒充实际 daemon。
test("public prepared-input entry produces R3 tar -> relocated bundle -> production Host resolver", async (t) => {
  const { root, config, options, version } = await createPreparedSourceServerFixture(t);
  await run(process.execPath, [prepare, "--source-server-config", config], {
    env: isolatedEnv(root),
    timeout: 120_000,
  });
  const outputDirectory = join(root, "installed resources", "remote-assets");
  const bundleConfig = join(root, "bundle-inputs.json");
  await writeFile(
    bundleConfig,
    JSON.stringify({ sourceDirectory: join(root, "cdn"), outputDirectory, version }),
  );
  const bundle = resolve(import.meta.dirname, "../bundle-remote-assets.mjs");
  await run(process.execPath, [bundle, "--config", bundleConfig], {
    env: isolatedEnv(root),
    timeout: 120_000,
  });
  await run(process.execPath, [bundle, "verify", outputDirectory, version], {
    env: isolatedEnv(root),
    timeout: 120_000,
  });
  const manifest = await verifyBundledRemoteAssets(outputDirectory, version);
  assert.equal(manifest.archives.length, 1);
  const runtime = await resolveSourceServerReleaseRuntimeOptions({
    expectedVersion: version,
    bundledRemoteAssetsDir: outputDirectory,
    cwd: join(root, "unrelated cwd"),
    env: {},
  });
  const asset = await resolveSourceServerReleaseAsset(
    { platform: "linux", arch: "x64" },
    undefined,
    runtime,
  );
  assert.equal(
    asset.localArchivePath,
    join(outputDirectory, "releases", version, "zcode-server-linux-x64.tar.gz"),
  );
  assert.deepEqual(
    await readFile(asset.localArchivePath),
    await readFile(join(options.outputDir, "zcode-server-linux-x64.tar.gz")),
  );
  const unpacked = join(root, "unpacked");
  await mkdir(unpacked);
  await run(resolveHostTarCommand(), ["-xzf", "zcode-server-linux-x64.tar.gz", "-C", unpacked], {
    cwd: join(outputDirectory, "releases", version),
  });
  const release = join(unpacked, "zcode-server-linux-x64");
  const runtimeManifest = JSON.parse(await readFile(join(release, "manifest.json"), "utf8"));
  assert.equal(runtimeManifest.appVersion, version);
  assert.equal(runtimeManifest.target, "linux-x64");
  assert.ok(
    (await readFile(join(release, "runtime/packages/node-repl-host/dist/mcp/server.js"))).length >
      0,
  );
});

test("prepare fails closed and withdraws the descriptor for missing/empty inputs or mismatched CLI version", async (t) => {
  const { options } = await createPreparedSourceServerFixture(t);
  for (const invalid of [
    { target: "win32-x64" },
    { agentBundlePath: join(options.outputDir, "missing-agent") },
    { nodeBinaryPath: join(options.outputDir, "missing-node") },
    { nativeToolsDir: undefined },
    { officialPluginsDir: undefined },
    { appVersion: "9.9.9" },
    { archive: false },
  ]) {
    await mkdir(options.outputDir, { recursive: true });
    const marker = join(options.outputDir, "source-server-release.json");
    await writeFile(marker, "old descriptor");
    await assert.rejects(prepareSourceServerRelease({ ...options, ...invalid }));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
  await writeFile(options.nodeBinaryPath, "");
  await assert.rejects(prepareSourceServerRelease(options), /Missing Source Server input/u);
});

test("R3 bundle rejects wrong/empty/duplicate targets, path escapes, versions, sizes and hashes", async (t) => {
  const { root, options } = await createRemoteAssetFixture(t);
  const descriptorPath = join(root, "releases", options.version, "source-server-release.json");
  const valid = JSON.parse(await readFile(descriptorPath, "utf8"));
  const archive = valid.archives[0];
  const invalids = [
    { ...valid, archives: [] },
    { ...valid, archives: [archive, archive] },
    { ...valid, version: "9.9.9", archives: [{ ...archive, version: "9.9.9" }] },
    ...[
      { target: "freebsd-x64" },
      { version: "9.9.9" },
      { fileName: "../secret.tar.gz" },
      { urls: ["../secret"] },
      { sizeBytes: archive.sizeBytes + 1 },
      { sha256: "0".repeat(64) },
    ].map((change) => ({ ...valid, archives: [{ ...archive, ...change }] })),
  ];
  for (const invalid of invalids) {
    await writeFile(descriptorPath, JSON.stringify(valid));
    await bundleRemoteAssets(options);
    await writeFile(descriptorPath, JSON.stringify(invalid));
    await assert.rejects(bundleRemoteAssets(options));
    await assert.rejects(
      readFile(
        join(options.outputDirectory, "releases", options.version, "source-server-release.json"),
      ),
      { code: "ENOENT" },
    );
  }
  await writeFile(descriptorPath, JSON.stringify(valid));
  await bundleRemoteAssets(options);
  await writeFile(
    join(options.outputDirectory, "releases", options.version, archive.fileName),
    "tampered",
  );
  await assert.rejects(
    verifyBundledRemoteAssets(options.outputDirectory, options.version),
    /size mismatch|SHA256 mismatch/u,
  );
});

test("R3 bundle refuses symlink escapes and cannot delete its source as output", async (t) => {
  const { root, options } = await createRemoteAssetFixture(t);
  await assert.rejects(
    bundleRemoteAssets({ ...options, outputDirectory: root }),
    /must not contain/u,
  );
  const descriptorPath = join(root, "releases", options.version, "source-server-release.json");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const file = join(root, "releases", options.version, descriptor.archives[0].fileName);
  const escaped = join(root, "outside-archive");
  await writeFile(escaped, await readFile(file));
  await rm(file);
  try {
    await symlink(escaped, file);
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    t.skip("Windows symlink creation needs Developer Mode or elevated privileges");
    return;
  }
  await assert.rejects(bundleRemoteAssets(options), /Invalid Source Server asset path/u);
});

test("legacy component manifests alone cannot produce a successful Source bundle", async (t) => {
  const { root, options } = await createRemoteAssetFixture(t);
  await rm(join(root, "releases", options.version, "source-server-release.json"), { force: true });
  await assert.rejects(bundleRemoteAssets(options), /source-server-release/u);
  await assert.rejects(
    readFile(
      join(options.outputDirectory, "releases", options.version, "source-server-release.json"),
    ),
    { code: "ENOENT" },
  );
});
