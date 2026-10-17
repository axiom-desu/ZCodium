#!/usr/bin/env node
import { access, chmod, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSeaTuiAssets,
  seaTuiAssetPrefix,
} from "../../../apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs";
import {
  assertSupportedTarget,
  normalizeTarget,
} from "../../../apps/zcode-cli/packages/cli/scripts/sea-targets.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "../..");

export function resolveDesktopCliTuiTarget(platformKey) {
  const target = normalizeTarget(platformKey);
  assertSupportedTarget(target);
  return { target, desktopKey: target.replace(/^win-/, "win32-") };
}

export async function verifyDesktopCliAssets({ glmDir, platformKey }) {
  const { target } = resolveDesktopCliTuiTarget(platformKey);
  const manifest = JSON.parse(await readFile(resolve(glmDir, "tui-manifest.json"), "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.target !== target ||
    !Array.isArray(manifest.files) ||
    !manifest.files.some(({ path }) => path === "node_modules/@zcode/tui/dist/index.js")
  ) {
    throw new Error(
      "Packaged Desktop CLI TUI manifest is incomplete or targets the wrong platform",
    );
  }
  await Promise.all(
    [
      "zcode.cjs",
      "provider/zcode-builtin.json",
      "THIRD-PARTY-NOTICES.md",
      ...manifest.files.map(({ path }) => {
        if (!path?.startsWith("node_modules/") || path.split(/[\\/]/).includes("..")) {
          throw new Error(`Invalid Desktop CLI asset path: ${path}`);
        }
        return path;
      }),
    ].map((path) => access(resolve(glmDir, path))),
  );
}

export async function stageDesktopCliTui({
  repoRoot: root = repoRoot,
  sourceRoot = resolve(root, "apps/zcode-cli"),
  platformKey,
  log = console.log,
}) {
  // SEA 使用 win-*，Desktop 资产 owner 使用 win32-*；不能把 Windows TUI 写入旁边的未打包目录。
  const { target, desktopKey } = resolveDesktopCliTuiTarget(platformKey);
  const glmDir = resolve(root, "packages/desktop/bundled-agents", desktopKey, "glm");
  const stagingDirectory = resolve(root, "packages/desktop/.tui-staging", desktopKey);
  const tuiManifest = resolve(sourceRoot, "packages/tui/dist/index.js");
  const runtimeManifest = resolve(sourceRoot, "packages/tui/dist/runtime-dependencies.json");
  const destination = resolve(glmDir, "node_modules");
  await rm(destination, { recursive: true, force: true });
  try {
    await access(tuiManifest);
    await access(runtimeManifest);
    const { assets, manifest } = await collectSeaTuiAssets({
      root: sourceRoot,
      stagingDirectory,
      target,
    });
    for (const file of manifest.files) {
      const assetPath = file.path;
      if (!assetPath.startsWith("node_modules/"))
        throw new Error(`Unexpected TUI asset path: ${assetPath}`);
      const source = assets[`${seaTuiAssetPrefix}${assetPath}`];
      const targetPath = resolve(glmDir, assetPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await cp(source, targetPath);
      await chmod(targetPath, file.mode);
    }
    await mkdir(glmDir, { recursive: true });
    await cp(resolve(stagingDirectory, "manifest.json"), resolve(glmDir, "tui-manifest.json"));
    const stagedManifest = JSON.parse(await readFile(resolve(glmDir, "tui-manifest.json"), "utf8"));
    if (
      stagedManifest.target !== target ||
      !stagedManifest.files.some(({ path }) => path === "node_modules/react/package.json")
    ) {
      throw new Error("Staged TUI manifest is incomplete or targets the wrong platform.");
    }
    log(`[stage:desktop-cli-tui] staged ${target} TUI runtime into ${destination}`);
    return { destination, manifestPath: resolve(glmDir, "tui-manifest.json") };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    await rm(resolve(glmDir, "tui-manifest.json"), { force: true });
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platformKey = process.argv[2] ?? `${process.platform}-${process.arch}`;
  stageDesktopCliTui({ platformKey }).catch((error) => {
    console.error(`[stage:desktop-cli-tui] ${error.message}`);
    process.exitCode = 1;
  });
}
