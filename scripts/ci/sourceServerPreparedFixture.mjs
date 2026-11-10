import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUILTIN_PLUGIN_ASSETS,
  cuaRuntimeRequiredPaths,
} from "@zcode/shared/builtin-plugin-assets";

/** 完整文件形状 fixture（不声称这些文本文件是生产 runtime）。 */
export async function createPreparedSourceServerFixture(t) {
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "zcode-r2-prepared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, text = "fixture\n") => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const version = "3.16.2";
  const distDir = join(root, "dist");
  await write(join(distDir, "package.json"), '{"type":"module"}');
  await write(
    join(distDir, "server-cli.js"),
    `console.log(JSON.stringify({product:"zcode-server", version:${JSON.stringify(version)}}));`,
  );
  await write(join(distDir, "server-core.js"), 'import "fixture-dep";');
  await write(
    join(root, "node_modules/fixture-dep/package.json"),
    '{"name":"fixture-dep","version":"1.0.0","main":"index.js"}',
  );
  await write(join(root, "node_modules/fixture-dep/index.js"), "module.exports = 1;\n");
  const bundledSkillsDir = join(root, "skills");
  for (const file of ["SKILL.md", "patterns.md", "examples.md"]) {
    await write(join(bundledSkillsDir, "skills/dynamic-workflows", file));
  }
  await write(join(bundledSkillsDir, "README.md"));
  const officialPluginsDir = join(root, "plugins");
  for (const plugin of BUILTIN_PLUGIN_ASSETS) {
    const directory = join(officialPluginsDir, plugin.directory);
    await write(join(directory, "package.json"), JSON.stringify({ name: plugin.packageName }));
    await write(join(directory, ".zcodium-plugin/plugin.json"), "{}");
    for (const path of plugin.requiredSeedPaths) await write(join(directory, path));
  }
  for (const path of cuaRuntimeRequiredPaths("linux", "x64")) {
    await write(join(officialPluginsDir, "node-repl-host", path));
  }
  const nativeToolsDir = join(root, "tools");
  for (const [id, name] of [
    ["bfs", "bfs"],
    ["ripgrep", "rg"],
    ["ugrep", "ugrep"],
  ]) {
    for (const file of [name, "THIRD-PARTY-NOTICES.txt", "SOURCES.json"])
      await write(join(nativeToolsDir, id, file));
  }
  await write(join(root, "agent.cjs"), "// fixture agent\n");
  await write(join(root, "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "node"), 0o755);
  const options = {
    target: "linux-x64",
    appVersion: version,
    distDir,
    agentBundlePath: join(root, "agent.cjs"),
    bundledSkillsDir,
    nodeBinaryPath: join(root, "node"),
    workspaceNodeModulesDir: join(root, "node_modules"),
    officialPluginsDir,
    nativeToolsDir,
    notices: { thirdParty: "fixture notices", node: "fixture node license", nodeSource: "{}" },
    outputDir: join(root, "cdn/releases", version),
    componentArchives: false,
  };
  const config = join(root, "prepared-inputs.json");
  await write(config, JSON.stringify(options));
  return { root, config, options, version };
}
