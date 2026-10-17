import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { targetParts } from "./sea-targets.mjs";
import {
  resolveRuntimePackageDirectory,
  placeRuntimePackage,
} from "./sea-runtime-package-resolution.mjs";
import { stageSeaPackageAssets } from "./sea-workspace-package-assets.mjs";

export const seaTuiAssetPrefix = "zcode-tui-runtime/";
export const seaTuiManifestAssetKey = `${seaTuiAssetPrefix}manifest.json`;

const workspacePackageParentDirectoryNames = ["packages", "tools"];

const opentuiCorePackageName = "@mbears/opentui-core";

export const opentuiNativePackageForTarget = (target) => {
  const { arch, releasePlatform } = targetParts(target);
  const packagePlatform = releasePlatform === "win" ? "win32" : releasePlatform;
  return `@mbears/opentui-core-${packagePlatform}-${arch}`;
};

export const collectSeaTuiAssets = async ({ root, stagingDirectory, target }) => {
  const workspacePackageDirectories = await discoverWorkspacePackageDirectories(root);
  const runtimeDependencies = await readTuiRuntimeDependencies(workspacePackageDirectories);
  const packageEntries = await runtimePackageNames({
    root,
    target,
    workspacePackageDirectories,
    runtimeDependencies,
  });
  const files = [];
  const assets = {};

  await rm(stagingDirectory, {
    force: true,
    recursive: true,
  });

  for (const { packageDirectory, packageName, assetPackagePath } of packageEntries) {
    const packageFiles = await collectPackageFiles({
      assetPackagePath,
      packageDirectory,
      packageName,
      target,
      workspacePackageDirectories,
    });

    const staged = await stageSeaPackageAssets({
      packageFiles,
      workspacePackage: workspacePackageDirectories.has(packageName),
      stagingDirectory,
      assetPrefix: seaTuiAssetPrefix,
      runtimeDependencies: packageName === "@zcode/tui" ? runtimeDependencies : undefined,
    });
    Object.assign(assets, staged.assets);
    files.push(...staged.files);
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifestHash = createHash("sha256")
    .update(JSON.stringify(files.map(({ path, sha256 }) => [path, sha256])))
    .digest("hex");
  const manifest = {
    files,
    hash: manifestHash,
    runtimeDependencies,
    schema: 1,
    target,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "manifest.json");
  await mkdir(stagingDirectory, {
    recursive: true,
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaTuiManifestAssetKey] = manifestPath;

  return {
    assets,
    manifest,
  };
};

const discoverWorkspacePackageDirectories = async (root) => {
  const directories = new Map();

  for (const parentDirectory of workspacePackageParentDirectories(root)) {
    let entries;
    try {
      entries = await readdir(parentDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(parentDirectory, entry.name);
      const packageJsonPath = resolve(directory, "package.json");
      if (!existsSync(packageJsonPath)) continue;

      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      const packageName = packageJson.name;
      if (typeof packageName !== "string" || packageName.length === 0) continue;
      if (directories.has(packageName)) {
        throw new Error(`Duplicate workspace package ${packageName}.`);
      }
      directories.set(packageName, directory);
    }
  }

  return directories;
};

const workspacePackageParentDirectories = (root) => {
  const repositoryRoot = resolve(root, "../..");

  return [
    ...workspacePackageParentDirectoryNames.map((directoryName) => resolve(root, directoryName)),
    // TUI runtime 闭包会经由 @zcode/contracts 依赖仓库根的 @zcode/shared；
    // 只扫描 apps/zcode-cli 子 workspace 会把这个合法 workspace 误判为缺失。
    resolve(repositoryRoot, "packages"),
  ];
};

const readTuiRuntimeDependencies = async (workspacePackageDirectories) => {
  const tuiDirectory = workspacePackageDirectories.get("@zcode/tui");
  if (!tuiDirectory) throw new Error("Missing @zcode/tui workspace package.");
  const manifestPath = resolve(tuiDirectory, "dist/runtime-dependencies.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing TUI runtime dependency manifest; rebuild @zcode/tui: ${manifestPath}`);
    }
    throw error;
  }
  if (
    manifest?.schema !== 1 ||
    !Array.isArray(manifest.externalDependencies) ||
    manifest.externalDependencies.some(
      (name) => typeof name !== "string" || !name.trim() || name.startsWith("@zcode/"),
    ) ||
    new Set(manifest.externalDependencies).size !== manifest.externalDependencies.length
  ) {
    throw new Error(`Invalid TUI runtime dependency manifest; rebuild @zcode/tui: ${manifestPath}`);
  }
  return [...manifest.externalDependencies].sort();
};

const runtimePackageNames = async ({ root, target, workspacePackageDirectories, runtimeDependencies }) => {
  const tuiDirectory = workspacePackageDirectories.get("@zcode/tui");
  const queue = [
    { fromDirectory: tuiDirectory, packageName: "@zcode/tui" },
    ...runtimeDependencies.map((packageName) => ({
      fromDirectory: tuiDirectory,
      packageName,
    })),
  ];
  const placements = new Map();
  const ordered = [];

  while (queue.length > 0) {
    const entry = queue.shift();
    const packageName = entry?.packageName;
    if (!packageName) continue;

    const packageDirectory = await realpath(
      await resolveRuntimePackageDirectory({
        fromDirectory: entry.fromDirectory,
        packageName,
        root,
        workspacePackageDirectories,
      }),
    );
    const assetPackagePath = placeRuntimePackage({
      packageName,
      packageDirectory,
      placements,
      fromAssetPath: entry.fromAssetPath ?? "node_modules/@zcode/tui",
    });
    if (!assetPackagePath) continue;
    ordered.push({
      assetPackagePath,
      packageDirectory,
      packageName,
    });

    const packageJson = JSON.parse(
      await readFile(resolve(packageDirectory, "package.json"), "utf8"),
    );
    // SEA 缓存目录无法解析 pnpm workspace 链接；旧的 @zcode 白名单漏掉 i18n
    // 后，构建仍成功但 TUI 启动才报错，因此这里必须按 manifest 递归收集依赖。
    for (const [dependencyName, dependencyRange] of Object.entries(
      packageName === "@zcode/tui" ? {} : packageJson.dependencies ?? {},
    )) {
      if (
        shouldQueueRuntimeDependency({
          dependencyName,
          dependencyRange,
          workspacePackageDirectories,
        })
      ) {
        queue.push({
          fromAssetPath: assetPackagePath,
          fromDirectory: packageDirectory,
          packageName: dependencyName,
        });
      }
    }
    if (packageName === opentuiCorePackageName) {
      queue.push({
        fromAssetPath: assetPackagePath,
        fromDirectory: packageDirectory,
        packageName: opentuiNativePackageForTarget(target),
      });
      for (const optionalName of ["koffi", "unsafe-pointer"]) {
        if (packageJson.optionalDependencies?.[optionalName]) {
          queue.push({
            fromAssetPath: assetPackagePath,
            fromDirectory: packageDirectory,
            packageName: optionalName,
          });
        }
      }
    }
  }

  return ordered;
};

const shouldQueueRuntimeDependency = ({
  dependencyName,
  dependencyRange,
  workspacePackageDirectories,
}) => {
  if (dependencyName.startsWith("@types/")) return false;

  if (typeof dependencyRange === "string" && dependencyRange.startsWith("workspace:")) {
    if (!workspacePackageDirectories.has(dependencyName)) {
      throw new Error(`Missing workspace runtime package ${dependencyName}.`);
    }
  }

  return true;
};

const collectPackageFiles = async ({
  assetPackagePath,
  packageDirectory,
  packageName,
  target,
  workspacePackageDirectories,
}) => {
  const files = [];
  const packageRoot = workspacePackageDirectories.get(packageName) ?? packageDirectory;

  for await (const sourcePath of walkFiles(packageRoot)) {
    const relativePath = relative(packageRoot, sourcePath);
    if (
      !shouldIncludePackageFile({
        packageName,
        relativePath,
        target,
        workspacePackageDirectories,
      })
    ) {
      continue;
    }

    files.push({
      assetPath: posix.join(assetPackagePath, toPosixPath(relativePath)),
      sourcePath,
    });
  }

  return files;
};

async function* walkFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

const toPosixPath = (value) => value.split(sep).join("/");

const shouldIncludePackageFile = ({
  packageName,
  relativePath,
  target,
  workspacePackageDirectories,
}) => {
  if (relativePath.endsWith(".map") || /\.tsx?$|\.d\.[cm]?ts$/.test(relativePath)) return false;

  if (workspacePackageDirectories.has(packageName)) {
    // Workspace runtime packages resolve in dev via pnpm links, so SEA must copy
    // their built package surface explicitly instead of relying on node_modules.
    return relativePath === "package.json" || relativePath.startsWith(`dist${sep}`);
  }

  if (packageName === "koffi") {
    return (
      ["index.d.ts", "index.js", "indirect.js", "LICENSE.txt", "package.json"].includes(
        relativePath,
      ) || relativePath === join("build", "koffi", koffiTripletForTarget(target), "koffi.node")
    );
  }

  if (packageName === "unsafe-pointer") {
    return (
      ["index.d.ts", "index.js", "index.mjs", "package.json"].includes(relativePath) ||
      unsafePointerNativePathsForTarget(target).has(relativePath)
    );
  }

  return true;
};

const koffiTripletForTarget = (target) => {
  const { arch, releasePlatform } = targetParts(target);
  const platform = releasePlatform === "win" ? "win32" : releasePlatform;
  return `${platform}_${arch}`;
};

const unsafePointerNativePathsForTarget = (target) => {
  const { arch, releasePlatform } = targetParts(target);
  const platform = releasePlatform === "win" ? "win32" : releasePlatform;
  const directory = join("prebuilds", `${platform}-${arch}`);
  const fileName = platform === "linux" ? "unsafe-pointer.glibc.node" : "unsafe-pointer.node";
  return new Set([join(directory, fileName)]);
};
