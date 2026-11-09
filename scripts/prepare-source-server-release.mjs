import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { validateBuiltinPluginAssets } from "./builtin-plugin-assets.mjs";
import {
  SOURCE_SERVER_DESCRIPTOR,
  parseSourceServerDescriptor,
  writeSourceServerDescriptor,
  verifySourceServerAssets,
} from "./source-server-assets.mjs";

const run = promisify(execFile);
const { stageRelease } = await tsImport(
  "../packages/zcode-server-cli/src/packaging/stage.ts",
  import.meta.url,
);
const { SOURCE_SERVER_RELEASE_TARGETS } = await tsImport("@zcode/shared", import.meta.url);

async function requireNonemptyFile(path) {
  const entry = await stat(path);
  if (!entry.isFile() || entry.size === 0) throw new Error(`Missing Source Server input: ${path}`);
}

async function validateTools(directory, target) {
  const suffix = target.startsWith("win32-") ? ".exe" : "";
  for (const [id, name] of [
    ["bfs", "bfs"],
    ["ripgrep", "rg"],
    ["ugrep", "ugrep"],
  ]) {
    await requireNonemptyFile(join(directory, id, `${name}${suffix}`));
  }
}

/** 只准备已有 stageRelease 的输入，不承担第二套依赖闭包或 archive 组装。 */
export async function workspacePackageDirectories(root) {
  const packages = new Map();
  for (const directory of [join(root, "packages"), join(root, "apps/zcode-cli/packages")]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      const json = await readFile(join(path, "package.json"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!json) continue;
      const { name } = JSON.parse(json);
      if (name) packages.set(name, path);
    }
  }
  return packages;
}

/**
 * 公开 prepare 的同一 R3 路径：只消费已准备的完整输入，descriptor 最后提交。
 * config 是 stage 参数，不是 release descriptor；安装仍只认 shared R3 契约。
 */
export async function prepareSourceServerRelease(options) {
  const { outputDir, appVersion: version, target } = options;
  if (!outputDir) throw new Error("Source Server outputDir is required");
  await mkdir(outputDir, { recursive: true });
  await rm(join(outputDir, SOURCE_SERVER_DESCRIPTOR), { force: true });
  if (!SOURCE_SERVER_RELEASE_TARGETS.includes(target)) {
    throw new Error(`Unsupported Source Server release target: ${target}`);
  }
  if (!version?.trim() || options.archive === false) {
    throw new Error("Source Server version and archive are required");
  }
  // 不能让空 Node/Agent 或不完整工具/插件被 stage 的可选项吞掉后伪装成可安装制品。
  for (const path of [options.nodeBinaryPath, options.agentBundlePath])
    await requireNonemptyFile(path);
  await validateTools(options.nativeToolsDir, target);
  const [platform, arch] = target.split("-");
  await validateBuiltinPluginAssets(options.officialPluginsDir, { platform, arch });
  const staged = await stageRelease({ ...options, archive: true });
  // 输入存在不等于发行闭包存在：校验 staging 的实际输出，不能脚本手补 packaging 漏项。
  await validateBuiltinPluginAssets(join(staged.releaseDir, "runtime/packages"), {
    platform,
    arch,
  });
  await validateTools(join(staged.releaseDir, "runtime/tools"), target);
  // 仓库外 dist 没有 node_modules 是合法输入；必须在唯一 packaging owner 组装闭包后验证。
  const { stdout } = await run(
    process.execPath,
    [join(staged.releaseDir, "runtime/server-cli.js"), "--version", "--json"],
    { cwd: staged.releaseDir, timeout: 30_000 },
  );
  const actual = JSON.parse(stdout);
  if (actual.product !== "zcode-server" || actual.version !== version) {
    throw new Error(
      `Source Server bundle version mismatch: expected ${version}, received ${actual.version}`,
    );
  }
  const bytes = await readFile(staged.archivePath);
  const fileName = `zcode-server-${target}.tar.gz`;
  const descriptor = parseSourceServerDescriptor(
    {
      schemaVersion: 1,
      version,
      archives: [
        {
          target,
          version,
          fileName,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
          urls: [fileName],
        },
      ],
    },
    version,
  );
  try {
    await writeSourceServerDescriptor(outputDir, descriptor);
    await verifySourceServerAssets(outputDir, version);
    return { ...staged, descriptor };
  } catch (error) {
    await rm(join(outputDir, SOURCE_SERVER_DESCRIPTOR), { force: true });
    throw error;
  }
}
