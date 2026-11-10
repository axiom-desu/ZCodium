import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_PLUGIN_ASSETS,
  cuaRuntimeRequiredPaths,
} from "@zcode/shared/builtin-plugin-assets";
import { currentServerTarget } from "../src/runtime/manifest.js";
import { stageRelease } from "../src/packaging/stage.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, content: string, root: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function writeKnownPlugin(pluginDirectory: string, root: string): Promise<void> {
  const plugin = BUILTIN_PLUGIN_ASSETS.find((entry) => entry.directory === pluginDirectory);
  if (!plugin) throw new Error(`Unknown fixture plugin: ${pluginDirectory}`);
  await write(`${pluginDirectory}/package.json`, `{ "name": "@zcode/${pluginDirectory}" }\n`, root);
  await write(`${pluginDirectory}/.zcodium-plugin/plugin.json`, "{}\n", root);
  for (const requiredPath of plugin.requiredSeedPaths)
    await write(`${pluginDirectory}/${requiredPath}`, `${requiredPath} fixture\n`, root);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** 构造一个真实形状的 pdf 面板产物：97 片字体 + pdfjs 目录 + worker + NOTICE。 */
async function writeOfficePdfPlugin(root: string): Promise<void> {
  await write(
    "pdf-plugin/package.json",
    `${JSON.stringify({ name: "@zcode/pdf-plugin", office: { kinds: ["pdf"] } })}\n`,
    root,
  );
  await write("pdf-plugin/.zcodium-plugin/plugin.json", "{}\n", root);
  const files = new Map<string, string>();
  files.set("dist/server.mjs", "// server\n");
  files.set("dist/THIRD_PARTY_NOTICES.txt", "notices\n");
  files.set("dist/LICENSE", "license\n");
  files.set("dist/ui/panel.html", "<html></html>\n");
  files.set("dist/ui/panel.css", "body{}\n");
  files.set("dist/ui/bundle-0.txt", "bundle\n");
  files.set("dist/ui/cjk-fallback.json", '{"faces":[]}\n');
  files.set("dist/ui/pdf-worker.js", "// worker\n");
  files.set("dist/ui/pdfjs/cmaps/UniGB-UCS2-H.bcmap", "cmap\n");
  files.set("dist/ui/pdfjs/standard_fonts/FoxitSans.pfb", "font\n");
  files.set("dist/ui/pdfjs/wasm/openjpeg.wasm", "wasm\n");
  for (let index = 0; index < 97; index += 1)
    files.set(`dist/ui/fonts/noto-sans-sc-${index}-400-normal.woff2`, `slice-${index}\n`);
  for (const [path, value] of files) await write(`pdf-plugin/${path}`, value, root);
  const manifest = {
    scripts: ["bundle-0.txt"],
    scriptBytes: Buffer.byteLength(files.get("dist/ui/bundle-0.txt")!),
    files: [...files.entries()].map(([path, value]) => ({
      path,
      bytes: Buffer.byteLength(value),
      sha256: sha256(value),
    })),
  };
  await write("pdf-plugin/dist/ui/assets.json", `${JSON.stringify(manifest)}\n`, root);
}

async function fixture(): Promise<{
  root: string;
  outputDir: string;
  options: Parameters<typeof stageRelease>[0];
}> {
  const root = await mkdtemp(join(tmpdir(), "zcode-r3-stage-"));
  roots.push(root);
  const distDir = join(root, "dist");
  const bundledSkillsDir = join(root, "source/bundled-skills");
  const officialPluginsDir = join(root, "source/plugins");
  const nodeModulesDir = join(root, "node_modules");
  await mkdir(nodeModulesDir, { recursive: true });
  await write(
    "fixture-dep/package.json",
    '{ "name": "fixture-dep", "version": "1.0.0" }\n',
    nodeModulesDir,
  );
  await write("fixture-dep/index.js", "module.exports = 1;\n", nodeModulesDir);
  await write("server-cli.js", 'require("fixture-dep")\n', distDir);
  await write("server-core.js", "// server core\n", distDir);
  await write("agent.cjs", "// agent\n", join(root, "agent"));
  await write("node", "fake node binary\n", join(root, "bin"));
  for (const file of ["SKILL.md", "patterns.md", "examples.md"]) {
    await write(`skills/dynamic-workflows/${file}`, `${file} v1\n`, bundledSkillsDir);
  }
  await write("README.md", "# bundled skills\n", bundledSkillsDir);
  await write("node_modules/ignored.js", "ignored\n", bundledSkillsDir);
  await write("fixtures/ignored.txt", "ignored\n", bundledSkillsDir);
  // 必须使用 shared 注册表里的内置插件名：未知 `*-plugin` 目录不能因为名字像插件被打进发行包。
  await writeKnownPlugin("image-search-plugin", officialPluginsDir);
  await write("image-search-plugin/scripts/runtime.js", "alpha v1\n", officialPluginsDir);
  // 残留的开发/测试目录必须被顶层白名单挡在组件 hash 之外。
  await write("image-search-plugin/src/evil.ts", "export const evil = 1;\n", officialPluginsDir);
  await write("image-search-plugin/test/fixture.ts", "// fixture\n", officialPluginsDir);
  await write("image-search-plugin/.turbo/cache", "cache\n", officialPluginsDir);
  await write("image-search-plugin/node_modules/leftover.js", "leftover\n", officialPluginsDir);
  await write(
    "evil-unknown-plugin/package.json",
    '{ "name": "evil-unknown-plugin" }\n',
    officialPluginsDir,
  );
  await write("evil-unknown-plugin/.zcodium-plugin/plugin.json", "{}\n", officialPluginsDir);

  return {
    root,
    outputDir: join(root, "out"),
    options: {
      target: currentServerTarget(),
      appVersion: "3.16.2",
      distDir,
      agentBundlePath: join(root, "agent/agent.cjs"),
      bundledSkillsDir,
      nodeBinaryPath: join(root, "bin/node"),
      notices: { thirdParty: "notices", node: "node license", nodeSource: "{}" },
      workspaceNodeModulesDir: nodeModulesDir,
      officialPluginsDir,
      outputDir: join(root, "out"),
      archive: false,
      componentArchives: false,
    },
  };
}

async function componentSha(outputDir: string, id: string): Promise<string | undefined> {
  const releaseDir = join(outputDir, `zcode-server-${currentServerTarget()}`);
  const manifest = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")) as {
    components?: Array<{ id: string; sha256: string; paths: string[] }>;
  };
  return manifest.components?.find((component) => component.id === id)?.sha256;
}

describe("server release staging assets", () => {
  it("copies only the shared plugin whitelist and its top-level runtime paths", async () => {
    const { outputDir, options } = await fixture();
    const releaseDir = join(outputDir, `zcode-server-${currentServerTarget()}`);
    await stageRelease(options);
    const manifest = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")) as {
      plugins: string[];
      components: Array<{ id: string; sha256: string; paths: string[] }>;
    };

    expect(
      await readFile(
        join(releaseDir, "runtime/packages/bundled-skills/skills/dynamic-workflows/SKILL.md"),
        "utf8",
      ),
    ).toBe("SKILL.md v1\n");
    expect(
      (await stat(join(releaseDir, "runtime/packages/bundled-skills/README.md"))).isFile(),
    ).toBe(true);
    // 实际复制内容：白名单内的运行资产存在，开发/测试/缓存目录与未知插件都必须缺席。
    expect(
      (
        await stat(join(releaseDir, "runtime/packages/image-search-plugin/scripts/runtime.js"))
      ).isFile(),
    ).toBe(true);
    expect(
      (await stat(join(releaseDir, "runtime/packages/image-search-plugin/.mcp.json"))).isFile(),
    ).toBe(true);
    for (const relativePath of [
      "runtime/packages/image-search-plugin/src",
      "runtime/packages/image-search-plugin/test",
      "runtime/packages/image-search-plugin/.turbo",
      "runtime/packages/image-search-plugin/node_modules",
      "runtime/packages/evil-unknown-plugin",
      "runtime/packages/bundled-skills/node_modules",
      "runtime/packages/bundled-skills/fixtures",
    ]) {
      expect(await stat(join(releaseDir, relativePath)).catch(() => null), relativePath).toBeNull();
    }

    const agentRuntime = manifest.components.find((component) => component.id === "agent-runtime");
    expect(agentRuntime?.paths).toContain("runtime/packages/bundled-skills");
    const officialPlugins = manifest.components.find(
      (component) => component.id === "official-plugins",
    );
    expect(officialPlugins?.paths).toEqual([
      "runtime/packages/image-search-plugin",
      "runtime/licenses/official-plugins",
    ]);
    expect(manifest.plugins).toEqual(["image-search"]);
  });

  it("recomputes component hashes from filtered runtime content and removes stale staging output", async () => {
    const { outputDir, options } = await fixture();
    const releaseDir = join(outputDir, `zcode-server-${currentServerTarget()}`);
    await stageRelease(options);
    const firstAgent = await componentSha(outputDir, "agent-runtime");
    const firstPlugins = await componentSha(outputDir, "official-plugins");

    // 只改被过滤目录/未知插件时，组件 hash 必须完全不变（证明不是“先整包复制再声明过滤”）。
    const filteredOnly = join(options.officialPluginsDir!, "image-search-plugin/test/extra.ts");
    await mkdir(dirname(filteredOnly), { recursive: true });
    await writeFile(filteredOnly, "// ignored\n");
    await write(
      "stale-plugin/package.json",
      '{ "name": "stale-plugin" }\n',
      options.officialPluginsDir,
    );
    await stageRelease(options);
    expect(await componentSha(outputDir, "official-plugins")).toBe(firstPlugins);

    await write(
      "skills/dynamic-workflows/SKILL.md",
      "SKILL.md v2 changed content\n",
      options.bundledSkillsDir,
    );
    // 只改白名单内的运行文件才应改变组件 hash。
    await write("image-search-plugin/scripts/runtime.js", "alpha v2\n", options.officialPluginsDir);
    await mkdir(join(releaseDir, "runtime/packages/stale-leftover"), { recursive: true });
    await stageRelease(options);

    expect(await componentSha(outputDir, "agent-runtime")).not.toBe(firstAgent);
    expect(await componentSha(outputDir, "official-plugins")).not.toBe(firstPlugins);
    expect(
      await stat(join(releaseDir, "runtime/packages/stale-leftover")).catch(() => null),
    ).toBeNull();
    expect(
      await stat(join(releaseDir, "runtime/packages/stale-plugin")).catch(() => null),
    ).toBeNull();
    expect(
      await stat(join(releaseDir, "runtime/packages/image-search-plugin/test")).catch(() => null),
    ).toBeNull();
  });

  it("stages node-repl-host with its fixed CUA closure and no other node_modules", async () => {
    const { outputDir, options } = await fixture();
    const [platform, arch] = currentServerTarget().split("-") as [string, string];
    const pluginRoot = options.officialPluginsDir!;
    // node-repl-host 不是 `*-plugin` 目录，旧实现会静默丢弃它。
    await writeKnownPlugin("node-repl-host", pluginRoot);
    for (const path of cuaRuntimeRequiredPaths(platform, arch)) {
      await write(`node-repl-host/${path}`, `${path} fixture\n`, pluginRoot);
    }
    // 只允许固定闭包：其它包与任何嵌套 node_modules 都不能进发行包。
    await write("node-repl-host/dist/mcp/node_modules/evil/index.js", "evil\n", pluginRoot);
    await write(
      "node-repl-host/dist/mcp/node_modules/@ubjs/core/node_modules/nested/x.js",
      "nested\n",
      pluginRoot,
    );

    await stageRelease(options);
    const releaseDir = join(outputDir, `zcode-server-${currentServerTarget()}`);
    const stagedPlugin = join(releaseDir, "runtime/packages/node-repl-host");
    for (const path of cuaRuntimeRequiredPaths(platform, arch)) {
      expect((await stat(join(stagedPlugin, path))).isFile(), path).toBe(true);
    }
    expect(
      await stat(join(stagedPlugin, "dist/mcp/node_modules/evil")).catch(() => null),
    ).toBeNull();
    expect(
      await stat(join(stagedPlugin, "dist/mcp/node_modules/@ubjs/core/node_modules")).catch(
        () => null,
      ),
    ).toBeNull();

    const manifest = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")) as {
      plugins: string[];
      components: Array<{ id: string; paths: string[] }>;
    };
    expect(manifest.plugins).toContain("node-repl-host");
    // 组件路径必须使用真实目录名，不能拼出 node-repl-host-plugin。
    expect(
      manifest.components.find((component) => component.id === "official-plugins")?.paths,
    ).toContain("runtime/packages/node-repl-host");
  });

  it("fails closed when a staged CUA runtime file is missing", async () => {
    const { options } = await fixture();
    const [platform, arch] = currentServerTarget().split("-") as [string, string];
    const pluginRoot = options.officialPluginsDir!;
    await writeKnownPlugin("node-repl-host", pluginRoot);
    for (const path of cuaRuntimeRequiredPaths(platform, arch)) {
      await write(`node-repl-host/${path}`, `${path} fixture\n`, pluginRoot);
    }
    const missing = cuaRuntimeRequiredPaths(platform, arch).at(-1)!;
    await rm(join(pluginRoot, "node-repl-host", ...missing.split("/")));
    // 缺一个 CUA 文件就不能产出可安装制品，不能发布半套运行时。
    await expect(stageRelease(options)).rejects.toThrow(/Missing staged CUA runtime asset/u);
  });

  it("fails closed when a non-entry office asset is missing from the built tree", async () => {
    const { outputDir, options } = await fixture();
    await writeOfficePdfPlugin(options.officialPluginsDir!);
    await stageRelease(options);
    const releaseDir = join(outputDir, `zcode-server-${currentServerTarget()}`);
    expect(
      await stat(join(releaseDir, "runtime/packages/pdf-plugin/dist/ui/pdfjs/wasm/openjpeg.wasm")),
    ).toBeTruthy();

    // 删除字体/worker/wasm/NOTICE 中任意一项都必须拒绝，而不是只检查三个入口文件。
    await rm(join(options.officialPluginsDir!, "pdf-plugin/dist/ui/pdfjs/wasm/openjpeg.wasm"));
    await expect(stageRelease(options)).rejects.toThrow(/Office viewer asset is missing/u);
  });
});
