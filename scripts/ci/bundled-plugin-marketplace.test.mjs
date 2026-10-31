import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";

const marketplace = await tsImport(
  "../../apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts",
  import.meta.url,
);
const bundled = await tsImport(
  "../../apps/zcode-cli/packages/adapters/src/plugins/official-marketplace.ts",
  import.meta.url,
);
const official = "zcode-plugins-official";
const json = (path, value) => writeFile(path, JSON.stringify(value));
async function fixture(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcodium-marketplace-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const requests = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error("Unexpected catalog network request");
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  const directory = join(storageRoot, "marketplaces", official);
  await mkdir(directory, { recursive: true });
  const seed = (plugins) =>
    bundled.writeBundledOfficialMarketplacePartitionSync({
      storageRoot,
      manifest: { name: official, plugins },
    });
  return { storageRoot, requests, directory, seed };
}

test("bundled catalog overrides neither seed nor identity with historical CDN data", async (t) => {
  const { storageRoot, requests, directory, seed } = await fixture(t);
  const old = {
    name: official,
    featured: ["remote-only"],
    plugins: [
      {
        name: "fixture-local",
        version: "999.0.0",
        source: { source: "url", url: "https://retired.invalid/override.zip" },
      },
      { name: "remote-only", source: { source: "url", url: "https://retired.invalid/extra.zip" } },
    ],
  };
  await json(join(directory, "cdn-marketplace.json"), old);
  await json(join(directory, "marketplace.json"), old);
  const knownPath = join(storageRoot, "known_marketplaces.json");
  await json(knownPath, {
    version: 1,
    marketplaces: [
      {
        id: official,
        name: official,
        source: { source: "url", url: "https://retired.invalid/marketplace.json" },
        pluginCount: 2,
        lastRefreshFailure: {
          code: "plugin_marketplace_invalid",
          message: "Old network failure",
          failedAt: "2020-01-01",
        },
      },
    ],
  });
  const plugins = [{ name: "fixture-local", source: "filesystem", version: "1.0.0" }];
  seed(plugins);
  assert.deepEqual(
    marketplace.loadMarketplaceManifestSync(storageRoot, official).raw.plugins,
    plugins,
  );
  const record = marketplace
    .loadKnownMarketplacesSync(storageRoot)
    .find((item) => item.id === official);
  assert.deepEqual(record.source, { source: "bundled" });
  assert.equal(record.pluginCount, 1);
  assert.equal(record.lastRefreshFailure, undefined);
  const before = await readFile(knownPath, "utf8");
  assert.deepEqual(await marketplace.updateMarketplace({ storageRoot, marketplace: official }), [
    record,
  ]);
  assert.equal(await readFile(knownPath, "utf8"), before);
  assert.equal(
    (await marketplace.ensureMarketplaceManifestAvailable({ storageRoot, marketplace: official }))
      .id,
    official,
  );
  // Even a leftover merged index overwritten after seed cannot regain authority.
  await json(join(directory, "marketplace.json"), old);
  assert.deepEqual(
    marketplace.loadMarketplaceManifestSync(storageRoot, official).raw.plugins,
    plugins,
  );
  seed([{ name: "replacement", source: "filesystem", version: "2.0.0" }]);
  assert.deepEqual(
    marketplace.loadMarketplaceManifestSync(storageRoot, official).plugins.map((item) => item.name),
    ["replacement"],
  );
  assert.deepEqual(requests, []);
});

test("missing or damaged bundled seed stays offline and never revives the old merged index", async (t) => {
  const { storageRoot, requests, directory } = await fixture(t);
  await json(join(directory, "marketplace.json"), {
    name: official,
    plugins: [{ name: "stale", source: "https://retired.invalid/plugin" }],
  });
  for (const corrupt of [
    undefined,
    "broken",
    JSON.stringify({ version: 1, manifest: { name: "wrong-market", plugins: [] } }),
  ]) {
    if (corrupt) await writeFile(join(directory, "bundled-marketplace.json"), corrupt);
    assert.equal(marketplace.loadMarketplaceManifestSync(storageRoot, official), null);
    await marketplace.ensureMarketplaceManifestAvailable({ storageRoot, marketplace: official });
    await marketplace.updateMarketplace({ storageRoot, marketplace: official });
    await assert.rejects(
      marketplace.installMarketplacePlugin({ storageRoot, marketplace: official, name: "stale" }),
    );
  }
  assert.deepEqual(requests, []);
});

test("a seeded plugin can be described and installed without fetching a catalog or archive", async (t) => {
  const { storageRoot, requests, seed } = await fixture(t);
  const cachePath = join(storageRoot, "cache", official, "fixture-local", "1.0.0");
  await mkdir(join(cachePath, ".zcodium-plugin"), { recursive: true });
  await mkdir(join(cachePath, "skills", "fixture-skill"), { recursive: true });
  await json(join(cachePath, ".zcodium-plugin", "plugin.json"), {
    name: "fixture-local",
    version: "1.0.0",
    description: "Offline fixture",
    skills: "./skills",
  });
  await writeFile(
    join(cachePath, "skills", "fixture-skill", "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Offline fixture\n---\nUse local files.\n",
  );
  seed([{ name: "fixture-local", source: "filesystem", version: "1.0.0", cachePath }]);
  const result = await marketplace.installMarketplacePlugin({
    storageRoot,
    marketplace: official,
    name: "fixture-local",
  });
  assert.equal(result.installed[0].installPath, cachePath);
  const description = await marketplace.describeMarketplacePlugin({
    storageRoot,
    marketplace: official,
    name: "fixture-local",
  });
  assert.equal(description.metadata.version, "1.0.0");
  assert.ok(
    description.components.some((group) =>
      group.items.some((item) => item.name === "fixture-skill"),
    ),
  );
  assert.deepEqual(requests, []);
});

test("personal URL refresh remains explicit, preserves the last good snapshot, and rejects reserved identity takeover", async (t) => {
  const { storageRoot, requests, seed } = await fixture(t);
  seed([]);
  let manifest = { name: "personal-fixture", plugins: [{ name: "one", source: "./one" }] };
  let fail = false;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (fail) throw new Error("Fixture unavailable");
    return new Response(JSON.stringify(manifest), {
      headers: { "content-type": "application/json" },
    });
  };
  const source = { source: "url", url: "https://self-managed.invalid/catalog.json" };
  await marketplace.addMarketplace({ storageRoot, source });
  manifest = { name: "personal-fixture", plugins: [{ name: "two", source: "./two" }] };
  const refreshed = await marketplace.updateMarketplace({ storageRoot });
  assert.equal(refreshed.length, 2);
  assert.deepEqual(
    marketplace
      .loadMarketplaceManifestSync(storageRoot, "personal-fixture")
      .plugins.map((item) => item.name),
    ["two"],
  );
  fail = true;
  await marketplace.updateMarketplace({ storageRoot, marketplace: "personal-fixture" });
  assert.equal(
    marketplace.loadMarketplaceManifestSync(storageRoot, "personal-fixture").plugins[0].name,
    "two",
  );
  assert.ok(
    marketplace
      .loadKnownMarketplacesSync(storageRoot)
      .find((item) => item.id === "personal-fixture").lastRefreshFailure,
  );
  fail = false;
  manifest = { name: official, plugins: [] };
  await assert.rejects(marketplace.addMarketplace({ storageRoot, source }), /reserved/);
  const count = requests.length;
  await assert.rejects(
    marketplace.addMarketplace({ storageRoot, source, trustedId: official }),
    /bundled/i,
  );
  assert.equal(requests.length, count);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(marketplace.updateMarketplace({ storageRoot, signal: abort.signal }), {
    name: "AbortError",
  });
  assert.equal(requests.length, count);
  assert.ok(requests.every((url) => url === source.url));
  const stored = JSON.parse(await readFile(join(storageRoot, "known_marketplaces.json"), "utf8"));
  assert.deepEqual(
    stored.marketplaces.map((item) => item.id),
    ["personal-fixture"],
  );
});

test("personal local sources keep their own directory contents and can be removed independently", async (t) => {
  const { storageRoot, requests, seed } = await fixture(t);
  seed([]);
  const path = join(storageRoot, "personal-source");
  await mkdir(join(path, ".claude-plugin"), { recursive: true });
  const file = join(path, ".claude-plugin", "marketplace.json");
  await json(file, { name: "local-fixture", plugins: [] });
  await marketplace.addMarketplace({ storageRoot, source: { source: "directory", path } });
  await json(file, { name: "local-fixture", description: "Updated local catalog", plugins: [] });
  await marketplace.updateMarketplace({ storageRoot, marketplace: "local-fixture" });
  assert.equal(
    marketplace.loadMarketplaceManifestSync(storageRoot, "local-fixture").description,
    "Updated local catalog",
  );
  await marketplace.removeMarketplace({ storageRoot, marketplace: "local-fixture" });
  assert.deepEqual(
    marketplace.loadKnownMarketplacesSync(storageRoot).map((item) => item.id),
    [official],
  );
  await assert.rejects(
    marketplace.removeMarketplace({ storageRoot, marketplace: official }),
    /cannot be removed/,
  );
  assert.deepEqual(requests, []);
});

test("runtime discovery does not adopt uninstalled legacy cache directories when seed is absent", async (t) => {
  const { storageRoot, requests, seed, directory } = await fixture(t);
  const { discoverNodePluginsSync } = await tsImport(
    "../../apps/zcode-cli/packages/adapters/src/plugins/index.ts",
    import.meta.url,
  );
  const root = join(storageRoot, "cache", official, "old-plugin", "1.0.0");
  await mkdir(join(root, ".zcodium-plugin"), { recursive: true });
  await json(join(root, ".zcodium-plugin", "plugin.json"), {
    name: "old-plugin",
    version: "1.0.0",
    description: "Fixture",
  });
  const discover = () =>
    discoverNodePluginsSync({
      storageRoot,
      workingDirectory: storageRoot,
      config: {
        enabled: true,
        dirs: [],
        enabledPlugins: {},
        options: {},
        suppressedBuiltins: [],
        extraKnownMarketplaces: {},
      },
    });
  assert.deepEqual(discover().plugins, []);
  seed([{ name: "old-plugin", source: "filesystem", version: "1.0.0", cachePath: root }]);
  await marketplace.installMarketplacePlugin({
    storageRoot,
    marketplace: official,
    name: "old-plugin",
  });
  await rm(join(directory, "bundled-marketplace.json"));
  const outcome = discover();
  assert.deepEqual(
    outcome.plugins.map((item) => item.id),
    [`old-plugin@${official}`],
    JSON.stringify(outcome.diagnostics),
  );
  assert.deepEqual(requests, []);
});

test("bundled listing definitions no longer contain official asset URLs", async () => {
  const { OFFICIAL_PLUGIN_DEFINITIONS } = await tsImport(
    "../../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    import.meta.url,
  );
  assert.doesNotMatch(
    JSON.stringify(OFFICIAL_PLUGIN_DEFINITIONS),
    /cdn-zcode|https:\/\/zcode\.z\.ai/,
  );
});

test("official Office4 catalog entries and manifests agree on the ui classification", async () => {
  const { OFFICIAL_PLUGIN_DEFINITIONS } = await tsImport(
    "../../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    import.meta.url,
  );
  for (const name of ["documents", "pdf", "presentations", "spreadsheets"]) {
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === name);
    assert.ok(definition, `${name} must stay in the bundled catalog`);
    assert.ok(definition.componentTypes?.includes("ui"), `${name} must be restorable as ui`);
    const manifest = JSON.parse(
      await readFile(
        new URL(
          `../../apps/zcode-cli/packages/${name}-plugin/.zcodium-plugin/plugin.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      manifest.ui?.surfaces?.map((surface) => surface.id),
      [name],
      `${name} must expose its built viewer surface`,
    );
    assert.equal(manifest.ui.surfaces[0].server, name);
    assert.ok(manifest.mcpServers?.[name], `${name} surface must bind the real MCP server`);
    assert.match(manifest.ui.surfaces[0].resourceUri, /^ui:\/\//u);
  }
});
