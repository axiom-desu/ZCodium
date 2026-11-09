import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bundleRemoteAssets, verifyBundledRemoteAssets } from "../bundle-remote-assets.mjs";
import { createRemoteAssetFixture as fixture, platform, version } from "./remoteAssetsFixture.mjs";

test("a relocatable bundle includes only verified archives and a manifest, retaining tar bytes", async (t) => {
  const { root, manifest, options } = await fixture(t);
  await bundleRemoteAssets(options);
  const bundled = await verifyBundledRemoteAssets(options.outputDirectory, version);
  assert.equal(bundled.sourceCommit, options.sourceCommit);
  assert.equal(bundled.components.length, 7);
  assert.ok(
    bundled.components
      .find((component) => component.id === "glm")
      .requiredPaths.includes("packages/node-repl-host/dist/mcp/server.js"),
  );
  assert.deepEqual((await readdir(options.outputDirectory)).sort(), [
    "components",
    "manifest-linux-x64.json",
    "releases",
  ]);
  for (const component of manifest.components) {
    assert.deepEqual(
      await readFile(join(options.outputDirectory, component.artifactPath)),
      await readFile(join(root, component.artifactPath)),
    );
  }
});

test("partial, duplicate, wrong platform/version and escaping manifests cannot be bundled", async (t) => {
  const { manifest, manifestPath, options } = await fixture(t);
  const invalids = [
    { ...manifest, components: manifest.components.slice(1) },
    { ...manifest, components: [...manifest.components, manifest.components[0]] },
    { ...manifest, platformArch: "linux-arm64" },
    { ...manifest, appVersion: "0.0.0" },
    {
      ...manifest,
      components: manifest.components.map((c, i) => (i ? c : { ...c, artifactPath: "../secret" })),
    },
    {
      ...manifest,
      components: manifest.components.map((c, i) => (i ? c : { ...c, mount: "../secret" })),
    },
  ];
  for (const invalid of invalids) {
    await writeFile(manifestPath, JSON.stringify(invalid));
    await assert.rejects(bundleRemoteAssets(options));
    await assert.rejects(readFile(join(options.outputDirectory, "manifest-linux-x64.json")), {
      code: "ENOENT",
    });
  }
});

test("missing source executors and corrupt archives fail; failed rebuild withdraws old manifest", async (t) => {
  const { root, manifest, options } = await fixture(t);
  await bundleRemoteAssets(options);
  const executor = join(
    root,
    "releases",
    version,
    "glm",
    platform,
    "packages/node-repl-host/dist/mcp/server.js",
  );
  await rm(executor);
  await assert.rejects(bundleRemoteAssets(options), /Missing remote component input/);
  await assert.rejects(readFile(join(options.outputDirectory, "manifest-linux-x64.json")), {
    code: "ENOENT",
  });
  await writeFile(executor, "fixture");
  await writeFile(join(root, manifest.components[0].artifactPath), "corrupt");
  await assert.rejects(bundleRemoteAssets(options), /SHA256 mismatch/);
});

test("installed artifact tampering is detected before use", async (t) => {
  const { manifest, options } = await fixture(t);
  await bundleRemoteAssets(options);
  await writeFile(join(options.outputDirectory, manifest.components[0].artifactPath), "corrupt");
  await assert.rejects(
    verifyBundledRemoteAssets(options.outputDirectory, version),
    /SHA256 mismatch/,
  );
});
