import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, cp, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { stageCuaDriverRuntime } from "../cua-driver-runtime-assets.mjs";
import { cuaRuntimeRequiredPaths } from "../../packages/shared/src/builtinPluginAssets.ts";

const run = promisify(execFile);
const sourceModules = resolve("node_modules");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zcodium-cua-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("isolated SDK loads its real Linux native libraries without workspace dependencies", async (t) => {
  if (process.platform !== "linux" || process.arch !== "x64")
    return t.skip("Linux x64 native check");
  const root = await fixture(t);
  await stageCuaDriverRuntime(root, { platform: "linux", arch: "x64" });
  await writeFile(
    join(root, "dist/mcp/check.mjs"),
    `
    globalThis.fetch = () => { throw new Error("Unexpected network"); };
    const { CuaDriver } = await import("@trycua/cua-driver");
    if (typeof CuaDriver.create !== "function") throw new Error("SDK missing");
    console.log("native-loaded");
  `,
  );
  const { stdout } = await run(process.execPath, [join(root, "dist/mcp/check.mjs")], {
    cwd: root,
    env: { ...process.env, NODE_PATH: "" },
  });
  assert.equal(stdout.trim(), "native-loaded");
});

test("cross staging replaces Linux assets with only the Windows target and preserves notices", async (t) => {
  const root = await fixture(t);
  await stageCuaDriverRuntime(root, { platform: "linux", arch: "x64" });
  await stageCuaDriverRuntime(root, { platform: "win32", arch: "x64" });
  const modules = join(root, "dist/mcp/node_modules");
  assert.deepEqual((await readdir(join(modules, "@trycua"))).sort(), [
    "cua-driver",
    "cua-driver-win32-x64-msvc",
  ]);
  for (const path of cuaRuntimeRequiredPaths("win32", "x64"))
    assert.ok((await readFile(join(root, path))).length);
  const native = join(modules, "@trycua/cua-driver-win32-x64-msvc");
  for (const name of ["cua_driver_sdk.dll", "cua_driver_node_runtime.node"]) {
    assert.equal((await readFile(join(native, name))).subarray(0, 2).toString(), "MZ");
  }
  assert.deepEqual(
    await readFile(join(native, "node-runtime-NOTICE.md")),
    await readFile(join(sourceModules, "@trycua/cua-driver-win32-x64-msvc/node-runtime-NOTICE.md")),
  );
});

test("missing dependencies, mismatched native versions and unsupported targets fail at build time", async (t) => {
  const root = await fixture(t);
  const input = join(root, "input");
  await assert.rejects(
    stageCuaDriverRuntime(join(root, "output"), { sourceModules: input }),
    /ENOENT/,
  );
  await assert.rejects(
    stageCuaDriverRuntime(root, { platform: "unknown", arch: "x64" }),
    /Unsupported CUA/,
  );
  for (const name of [
    "@trycua/cua-driver",
    "@trycua/cua-driver-linux-x64-gnu",
    "@ubjs/core",
    "@ubjs/node",
  ]) {
    await cp(join(sourceModules, name), join(input, name), { recursive: true, dereference: true });
  }
  const manifest = join(input, "@trycua/cua-driver-linux-x64-gnu/package.json");
  const original = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(manifest, JSON.stringify({ ...original, version: "0.0.0" }));
  await assert.rejects(
    stageCuaDriverRuntime(join(root, "output"), {
      sourceModules: input,
      platform: "linux",
      arch: "x64",
    }),
    /version mismatch/,
  );
});

test("Windows CUA uses the shared host only when enabled; browser-only never enables CUA", async () => {
  const { resolveBuiltInNodeReplMcpServers: configure } = await tsImport(
    "../../apps/zcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts",
    import.meta.url,
  );
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  const plugin = (name, enabled = true) => ({
    id: `${name}@zcode-plugins-official`,
    rootPath: "/fixture",
    enabled,
  });
  const config = (plugins) =>
    configure({ pluginOutcome: { plugins }, workingDirectory: "/fixture" });
  try {
    for (const platform of ["win32", "linux"]) {
      Object.defineProperty(process, "platform", { value: platform });
      const host = plugin("node-repl-host");
      assert.deepEqual(config([host, plugin("computer-use", false)]), {});
      assert.deepEqual(config([plugin("computer-use")]), {});
      const browser = config([host, plugin("browser-use")]).node_repl;
      assert.equal(browser.env.ZCODE_CUA_DRIVER_EMBEDDED, undefined);
      const cua = config([host, plugin("computer-use")]).node_repl;
      assert.equal(cua.env.ZCODE_CUA_DRIVER_EMBEDDED, "1");
      assert.equal(cua.env.ZCODE_CUA_DRIVER_SOCKET, undefined);
      assert.equal(cua.isolation, "workspace");
    }
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("first-start seed carries native dependencies, excludes workspace modules and repairs a missing library", async (t) => {
  const { resolveOfficialPluginRoots } = await tsImport(
    "../../apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts",
    import.meta.url,
  );
  const { OFFICIAL_PLUGIN_DEFINITIONS } = await tsImport(
    "../../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    import.meta.url,
  );
  // 缓存目录取的是官方 seed 定义里的 version，不是 fixture 自己写的那个——两者不一致时
  // 这里会直接找不到目录。所以从定义取值，不写死字面量。
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((entry) => entry.name === "node-repl-host");
  assert.ok(definition, "node-repl-host must have an official plugin definition");
  // 五处版本一致（package.json / manifest / serverInfo / 定义 / SEA 清单）里的前三处：
  // manifest 是真实读盘的那份，与定义逐字一致才不会让官方 seed 继续加载旧缓存目录。
  const manifest = JSON.parse(
    await readFile(
      resolve("apps/zcode-cli/packages/node-repl-host/.zcodium-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.version, definition.version);
  const root = await fixture(t);
  const source = join(root, "packages/node-repl-host");
  await mkdir(join(source, ".zcodium-plugin"), { recursive: true });
  await writeFile(
    join(source, ".zcodium-plugin/plugin.json"),
    JSON.stringify({ name: "node-repl-host", version: definition.version }),
  );
  await stageCuaDriverRuntime(source);
  await writeFile(join(source, "dist/mcp/server.js"), "// seed fixture");
  await mkdir(join(source, "node_modules/unrelated"), { recursive: true });
  await writeFile(join(source, "node_modules/unrelated/secret.txt"), "not a runtime asset");
  const entrypoint = process.argv[1];
  process.argv[1] = join(root, "zcode.cjs");
  try {
    const storageRoot = join(root, "storage");
    resolveOfficialPluginRoots({ storageRoot });
    const cache = join(
      storageRoot,
      `cache/zcode-plugins-official/node-repl-host/${definition.version}`,
    );
    for (const path of cuaRuntimeRequiredPaths(process.platform, process.arch)) {
      assert.deepEqual(await readFile(join(cache, path)), await readFile(join(source, path)));
    }
    await assert.rejects(access(join(cache, "node_modules/unrelated/secret.txt")), {
      code: "ENOENT",
    });
    const nativePath = cuaRuntimeRequiredPaths(process.platform, process.arch).at(-2);
    await rm(join(cache, nativePath));
    resolveOfficialPluginRoots({ storageRoot });
    assert.deepEqual(
      await readFile(join(cache, nativePath)),
      await readFile(join(source, nativePath)),
    );
  } finally {
    process.argv[1] = entrypoint;
  }
});
