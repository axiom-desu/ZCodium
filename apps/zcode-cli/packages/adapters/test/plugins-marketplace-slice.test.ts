import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as marketplace from "../src/plugins/marketplace.js";
import * as pluginIndex from "../src/plugins/index.js";
import { installMarketplacePlugin, updateMarketplace } from "../src/plugins/marketplace.js";
import { normalizeZipRelativePath, resolveZipPathWithin } from "../src/plugins/zip-source-paths.js";

const PUBLIC_MARKETPLACE_EXPORTS = [
  "addMarketplace",
  "describeMarketplacePlugin",
  "ensureMarketplaceManifestAvailable",
  "getPluginDataDir",
  "installMarketplacePlugin",
  "listInstalledPluginRecords",
  "loadKnownMarketplacesSync",
  "loadMarketplaceManifestSync",
  "normalizeAuthorValue",
  "parseEntryStoreListing",
  "parseMarketplaceSourceInput",
  "readPluginSourceIdentityPin",
  "readPluginSourceSha",
  "removeMarketplace",
  "uninstallMarketplacePlugin",
  "updateMarketplace",
  "validateMarketplacePlugin",
  "validateLocalPluginPath",
  "validateMarketplaceSource",
] as const;

async function tempStorage(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "zcode-plugin-slice-"));
}

test("plugin adapter entry keeps the marketplace export surface", () => {
  for (const name of PUBLIC_MARKETPLACE_EXPORTS) {
    assert.equal(typeof marketplace[name], "function", `marketplace missing ${name}`);
    assert.equal(typeof pluginIndex[name], "function", `index missing ${name}`);
  }
});

test("refresh failure is projected to known marketplaces without changing source", async () => {
  const storageRoot = await tempStorage();
  try {
    await mkdir(storageRoot, { recursive: true });
    const knownPath = join(storageRoot, "known_marketplaces.json");
    await writeFile(
      knownPath,
      JSON.stringify({
        version: 1,
        marketplaces: [
          {
            id: "broken-market",
            name: "broken-market",
            pluginCount: 0,
            source: { source: "file", path: join(storageRoot, "missing-marketplace.json") },
          },
        ],
      }),
    );

    const updated = await updateMarketplace({ marketplace: "broken-market", storageRoot });
    assert.deepEqual(updated, []);
    const known = JSON.parse(await readFile(knownPath, "utf8")) as {
      marketplaces: Array<{ id: string; lastRefreshFailure?: { code: string } }>;
    };
    assert.equal(known.marketplaces[0]?.id, "broken-market");
    assert.equal(known.marketplaces[0]?.lastRefreshFailure?.code, "plugin_marketplace_invalid");
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("aborted refresh is control flow, not a persisted marketplace failure", async () => {
  const storageRoot = await tempStorage();
  try {
    const knownPath = join(storageRoot, "known_marketplaces.json");
    await writeFile(
      knownPath,
      JSON.stringify({
        version: 1,
        marketplaces: [
          {
            id: "abort-market",
            name: "abort-market",
            pluginCount: 0,
            source: { source: "file", path: join(storageRoot, "missing.json") },
          },
        ],
      }),
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      updateMarketplace({
        marketplace: "abort-market",
        signal: controller.signal,
        storageRoot,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    const known = JSON.parse(await readFile(knownPath, "utf8")) as {
      marketplaces: Array<{ lastRefreshFailure?: unknown }>;
    };
    assert.equal(known.marketplaces[0]?.lastRefreshFailure, undefined);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("invalid archive paths are rejected before extraction writes outside root", () => {
  assert.throws(() => normalizeZipRelativePath("../escape"), /Unsafe plugin zip path/u);
  assert.throws(() => normalizeZipRelativePath("/absolute"), /Unsafe plugin zip path/u);
  assert.throws(() => normalizeZipRelativePath("nested\\escape"), /Unsafe plugin zip path/u);
  assert.throws(() => resolveZipPathWithin("/tmp/root", "../escape"), /Unsafe plugin zip path/u);
  assert.equal(normalizeZipRelativePath("nested/plugin.json"), "nested/plugin.json");
});

test("install failure rolls back staged cache and installed state", async () => {
  const storageRoot = await tempStorage();
  try {
    const marketplaceDir = join(storageRoot, "marketplaces", "test-market");
    const pluginDir = join(storageRoot, "source", "good-plugin");
    await mkdir(marketplaceDir, { recursive: true });
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "good-plugin", version: "1.2.3" }),
    );
    await writeFile(
      join(marketplaceDir, "marketplace.json"),
      JSON.stringify({
        name: "test-market",
        plugins: [
          { name: "good-plugin", source: { source: "directory", path: pluginDir } },
          {
            name: "broken-plugin",
            source: { source: "directory", path: join(storageRoot, "source", "missing") },
          },
          {
            name: "root-plugin",
            dependencies: ["good-plugin", "broken-plugin"],
            source: { source: "directory", path: pluginDir },
          },
        ],
      }),
    );

    await assert.rejects(
      installMarketplacePlugin({
        marketplace: "test-market",
        name: "root-plugin",
        storageRoot,
      }),
      /Plugin source directory does not exist/u,
    );
    assert.equal(existsSync(join(storageRoot, "installed_plugins.json")), false);
    assert.equal(
      existsSync(join(storageRoot, "cache", "test-market", "good-plugin", "1.2.3")),
      false,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});
