#!/usr/bin/env node
import {
  BUILTIN_PLUGIN_ASSETS,
  BUILTIN_PLUGIN_REQUIRED_PATHS,
  BUILTIN_PLUGIN_TOP_LEVEL_PATHS,
} from "@zcode/shared/builtin-plugin-assets";
/* eslint-disable max-lines */

import { access, cp, mkdir, rm } from "node:fs/promises";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveRemoteNativeSearchPrebuiltPlan } from "./remote-native-search-tools-config.mjs";
import { prepareNativeSearchTools } from "./prepare-native-search-tools.mjs";
import { stageThirdPartyNotices } from "./third-party-notices.mjs";
import {
  computeDeterministicSourceSha256 as computeComponentSourceSha256,
  packSourceAsDeterministicTarGzip as packComponentSourceAsArchive,
} from "./deterministic-tar-archive.mjs";
import { runCommand } from "./spawn-command.mjs";
import { prepareRemoteNode, REMOTE_NODE_VERSION } from "./remote-node-runtime.mjs";
import { bundleRepositoryRemoteAssets } from "./bundle-remote-assets.mjs";
import {
  validateBuiltinPluginAssets,
  validateStagedOfficeViewerAssets,
} from "./builtin-plugin-assets.mjs";
import { stageCuaDriverRuntime } from "./cua-driver-runtime-assets.mjs";
import { getBuildMetadata } from "../packages/desktop/scripts/build-metadata.mjs";
export { DEFAULT_NODE_DIST_BASE, nodeDistBase } from "./remote-node-runtime.mjs";

export { computeComponentSourceSha256, packComponentSourceAsArchive };

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const desktopDir = join(rootDir, "packages/desktop");
const mockCdnDir = join(desktopDir, "mock-cdn");
// 版本串唯一来源：与 electron-builder beforePack 的 bundled-remote 校验、desktop-release collect
// 的产物名匹配同源。直接读 package.json 会让 manifest.appVersion 停在裸基线上，与构建期滚动
// 版本串漂移，beforePack 的相等校验必炸。getBuildMetadata 与打包侧读取同一函数，浅克隆告警也一致。
const { appVersion: version } = getBuildMetadata();
const agentVersion = require(join(rootDir, "apps/zcode-cli/package.json")).version;
const releaseDir = join(mockCdnDir, "releases", version);
const nodeVersion = REMOTE_NODE_VERSION;
const componentSchemaVersion = 1;
const remotePlatforms = ["linux-x64"];
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";
const remoteOfficialPluginPackages = BUILTIN_PLUGIN_ASSETS;
// 随 CLI 内置的技能包（不是插件）：远端 agent 的 bootstrap 沿官方插件同款候选目录在 zcode.cjs 旁
// 找 packages/bundled-skills 并原地读取；与 packages/desktop/scripts/prepare-agent-node-bundle.mjs 同一份清单。
const remoteBundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["skills"],
};
const remoteOfficialPluginTopLevelPaths = new Set(BUILTIN_PLUGIN_TOP_LEVEL_PATHS);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}
const remoteOfficialPluginRequiredPaths = BUILTIN_PLUGIN_REQUIRED_PATHS.map(
  (path) => `packages/${path}`,
);

function resolveDedicatedPackageRoot(packageName, fromDir) {
  const packageEntryPath = require.resolve(packageName, { paths: [fromDir] });
  let currentDir = dirname(packageEntryPath);

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = require(packageJsonPath);
      if (packageJson?.name === packageName) {
        return currentDir;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error(
    `Unable to resolve package root for ${packageName} from entry ${packageEntryPath}`,
  );
}

function resolveNodePtyPackageName(platformKey) {
  return `@lydell/node-pty-${platformKey}`;
}

function resolveNodePtyPackageVersion(platformKey) {
  const packageName = resolveNodePtyPackageName(platformKey);
  const packageRoot = resolveDedicatedPackageRoot(packageName, join(rootDir, "packages/server"));
  const packageJson = require(join(packageRoot, "package.json"));
  if (typeof packageJson?.version !== "string" || !packageJson.version.trim()) {
    throw new Error(`Unable to resolve version for ${packageName}`);
  }
  return packageJson.version.trim();
}

async function prepareNodeBinaries() {
  for (const platform of remotePlatforms) {
    await prepareRemoteNode({
      platform,
      outputDirectory: join(releaseDir, "node", platform),
      cacheDirectory: join(rootDir, ".cache", "remote-node"),
      root: rootDir,
    });
  }
}

function buildServerBundle() {
  console.log("==> Building server bundle");

  try {
    if (isBootstrapWithRemote) {
      runBootstrapServerRemoteBuild();
      return;
    }

    // Windows CI（Node 24）里直接 spawnSync("pnpm.cmd") 会在拉起子进程前就抛 EINVAL。
    // 这里统一走跨平台启动封装，让 .cmd 通过 shell/cmd.exe 执行，避免远端资源准备阶段提前中断。
    runCommand(pnpmCommand, ["run", "build:remote"], {
      cwd: join(rootDir, "packages/server"),
    });
  } catch (error) {
    console.error(
      "  [error] packages/server build:remote 失败，请优先检查 CI 日志中的 TypeScript / esbuild 输出",
    );
    throw error;
  }
}

function runBootstrapServerRemoteBuild() {
  // bootstrap:with-remote 会在本地串联 install、remote assets、workspace build。
  // 这里不能复用已有 zcode-server.cjs：开发时 package version 常不变，旧 bundle 会把缺少新 RPC 的
  // server 部署到 SSH 远端。只保留“直接用当前 Node 启动 tsx”的低内存优化，不改变 CI 的 build:remote。
  runCommand(
    process.execPath,
    [join(rootDir, "node_modules/tsx/dist/cli.mjs"), "build-remote.ts"],
    {
      cwd: join(rootDir, "packages/server"),
      env: process.env,
    },
  );
}

function copyServerBundle() {
  const serverDir = join(releaseDir, "server");
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(
    join(rootDir, "packages/server/dist/remote/zcode-server.cjs"),
    join(serverDir, "zcode-server.cjs"),
  );
  console.log("  [ok] mock-cdn server/zcode-server.cjs");
}

function copyNodePtyPrebuilds() {
  console.log("==> Copying node-pty prebuilds from @lydell/node-pty");

  for (const platformKey of remotePlatforms) {
    const ptyDir = join(releaseDir, "node-pty", platformKey);
    const targetBinaryPath = join(ptyDir, "pty.node");
    const targetSpawnHelperPath = join(ptyDir, "spawn-helper");
    const requiresSpawnHelper = platformKey.startsWith("darwin-");

    mkdirSync(ptyDir, { recursive: true });

    const packageName = resolveNodePtyPackageName(platformKey);
    const packageRoot = resolveDedicatedPackageRoot(packageName, join(rootDir, "packages/server"));
    const sourcePrebuildDir = join(packageRoot, "prebuilds", platformKey);
    const sourceBinaryPath = join(sourcePrebuildDir, "pty.node");
    if (!existsSync(sourceBinaryPath)) {
      throw new Error(`Missing PTY binary: ${sourceBinaryPath}`);
    }

    // Darwin 平台 node-pty 除了 pty.node 还依赖 spawn-helper。
    // 之前 mock-cdn 只复制了 pty.node，远端部署后会在 terminal.create 阶段报 posix_spawn ENOENT。
    // 这里把 spawn-helper 一并拷贝进 remote 资产目录，避免远端终端启动时缺关键二进制。
    copyFileSync(sourceBinaryPath, targetBinaryPath);
    if (requiresSpawnHelper) {
      const sourceSpawnHelperPath = join(sourcePrebuildDir, "spawn-helper");
      if (!existsSync(sourceSpawnHelperPath)) {
        throw new Error(`Missing PTY spawn helper: ${sourceSpawnHelperPath}`);
      }
      copyFileSync(sourceSpawnHelperPath, targetSpawnHelperPath);
      chmodSync(targetSpawnHelperPath, 0o755);
    }
    console.log(`  [ok] mock-cdn node-pty/${platformKey} (copied from ${packageName})`);
  }
}

function buildRemoteOfficialPluginRuntimes() {
  for (const plugin of remoteOfficialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`==> Building remote official plugin runtime: ${plugin.packageName}`);
    if (isBootstrapWithRemote) {
      buildRemoteOfficialPluginRuntimeForBootstrap(plugin);
      assertRemoteOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      pnpmCommand,
      ["--dir", join(rootDir, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: rootDir,
        env: process.env,
      },
    );
    assertRemoteOfficialPluginRuntime(plugin);
  }
}

function buildRemoteOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = join(rootDir, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(join(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(`  [skip] reuse existing remote official plugin runtime: ${plugin.packageName}`);
    return;
  }

  // bootstrap:with-remote 会串行准备远端资源和工作区构建。
  // 官方插件 runtime 只在 stage 资源时需要，这里用当前 Node 执行等价构建，避免再嵌套 pnpm/tsc shim。
  // browser-use 的 MCP server 与 browser-client 必须来自同一次构建；只凭旧 server.js 判定可复用
  // 会让远端资源混入陈旧或缺失的 client，因此 bootstrap 模式下对该插件无条件重建。
  // 文档查看面板插件没有自己的 tsconfig；没有配置时跳过 tsc，直接运行 office-runtime 构建脚本。
  if (existsSync(join(pluginRoot, "tsconfig.json")))
    runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: pluginRoot,
      env: process.env,
    });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertRemoteOfficialPluginRuntime(plugin) {
  const pluginRoot = join(rootDir, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare-prebuilds] missing remote official plugin runtime: ${runtimePath}`);
    }
  }
}

async function stageRemoteOfficialPlugins(glmDir) {
  for (const plugin of remoteOfficialPluginPackages) {
    const sourceRoot = join(rootDir, plugin.relativePath);
    const manifestPath = join(sourceRoot, ".zcodium-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `[prepare-prebuilds] missing remote official plugin manifest: ${manifestPath}`,
      );
    }

    const targetRoot = join(glmDir, ...plugin.stagedPath.split("/"));
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of remoteOfficialPluginTopLevelPaths) {
      const sourcePath = join(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, join(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    if (plugin.directory === "node-repl-host") {
      await stageCuaDriverRuntime(targetRoot, { platform: "linux", arch: "x64" });
    }
    for (const relativePath of remoteOfficialPluginRequiredPaths) {
      if (!relativePath.startsWith(`${plugin.stagedPath}/`)) continue;
      const stagedAssetPath = join(glmDir, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare-prebuilds] missing staged remote official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    await validateStagedOfficeViewerAssets(targetRoot);
    console.log(`  [ok] mock-cdn glm official plugin ${plugin.stagedPath}`);
  }
  await validateBuiltinPluginAssets(join(glmDir, "packages"), { platform: "linux", arch: "x64" });
}

async function stageRemoteBundledSkillPack(glmDir) {
  const sourceRoot = join(rootDir, remoteBundledSkillPack.relativePath);
  const targetRoot = join(glmDir, ...remoteBundledSkillPack.stagedPath.split("/"));
  await mkdir(targetRoot, { recursive: true });
  for (const entryName of remoteBundledSkillPack.topLevelPaths) {
    const sourcePath = join(sourceRoot, entryName);
    await cp(sourcePath, join(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of remoteBundledSkillPack.requiredPaths) {
    const stagedAssetPath = join(targetRoot, ...relativePath.split("/"));
    await access(stagedAssetPath);
  }
  console.log(`  [ok] mock-cdn glm bundled skill pack ${remoteBundledSkillPack.stagedPath}`);
}

// 远端 agent 现在跑编译出来的 zcode.cjs（而不是各平台独立的原生二进制）：
// 远端部署时已经有一份独立 node（跑 zcode-server.cjs），agent 复用它执行 zcode.cjs 即可，
// 不必再为每个平台准备一份内嵌 node 的 SEA 二进制。zcode.cjs 跨平台同一份，逐平台只是放进各自的
// glm/<platform> 组件目录，保持现有 manifest 组件结构不变。
async function stageRemoteAgentBundles() {
  console.log("==> Building zcode-cli bundle for remote agents");
  // 复用桌面同款构建脚本（turbo build:desktop-agent --filter=@zcode/cli），命中缓存时几乎瞬时。
  runCommand(process.execPath, [join(rootDir, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: rootDir,
    env: process.env,
  });
  // browser-use runtime 的 tsc 依赖 @zcode/core/dist。远端资产也必须先构建
  // agent CLI 依赖，避免 CI 干净检出时被开发机缓存掩盖的 TS2307。
  buildRemoteOfficialPluginRuntimes();
  const cliBundlePath = join(rootDir, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[prepare-prebuilds] expected cli bundle missing: ${cliBundlePath}`);
  }

  for (const platformKey of remotePlatforms) {
    const glmDir = join(releaseDir, "glm", platformKey);
    // 干净重建：glm 组件现在只含 zcode.cjs，清掉历史遗留的原生二进制 / 旧 meta，
    // 避免被打进组件 tar 把远端资源撑大。
    rmSync(glmDir, { recursive: true, force: true });
    mkdirSync(glmDir, { recursive: true });
    copyFileSync(cliBundlePath, join(glmDir, "zcode.cjs"));
    await stageRemoteOfficialPlugins(glmDir);
    await stageRemoteBundledSkillPack(glmDir);
    console.log(`  [ok] mock-cdn glm/${platformKey}/zcode.cjs`);
  }
}

export async function prepareRemoteNativeSearchTools({
  platforms = remotePlatforms,
  outputDir = join(releaseDir, "tools"),
} = {}) {
  console.log("==> Preparing local native search binaries for remote platforms");
  for (const platformKey of platforms) {
    const [targetOs, targetArch] = platformKey.split("-");
    if (!targetOs || !targetArch) {
      throw new Error(`Invalid remote platform key: ${platformKey}`);
    }

    await prepareNativeSearchTools({
      prebuiltPlan: resolveRemoteNativeSearchPrebuiltPlan({
        platform: targetOs,
        arch: targetArch,
        outputDir: join(outputDir, platformKey),
      }),
    });
  }
}

function joinPosix(...segments) {
  return segments.join("/").replace(/\/+/g, "/");
}

function normalizeSemanticPrefix(rawPrefix, fallback = "v1") {
  const prefix = String(rawPrefix ?? "").trim();
  if (!prefix) {
    return fallback;
  }

  const normalized = prefix.replace(/\+/g, "-");
  if (!normalized) {
    return fallback;
  }
  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

function computeFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function buildComponentVersion(semanticPrefix) {
  return normalizeSemanticPrefix(semanticPrefix);
}

export function buildContentAddressedComponentVersion(semanticPrefix, sha256) {
  const normalizedSha = String(sha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedSha)) {
    throw new Error(`Invalid component sha256: ${sha256}`);
  }
  return `${buildComponentVersion(semanticPrefix)}+${normalizedSha.slice(0, 12)}`;
}

export function buildComponentArtifactRelativePath(platformKey, componentId, componentVersion) {
  return joinPosix("components", platformKey, componentId, `${componentVersion}.tar.gz`);
}

function resolveComponentSemanticVersion(componentVersion) {
  const version = String(componentVersion ?? "").trim();
  const plusIndex = version.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === version.length - 1) {
    return version;
  }

  const suffix = version.slice(plusIndex + 1).toLowerCase();
  return /^[a-f0-9]{12,64}$/.test(suffix) ? version.slice(0, plusIndex) : version;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeManifestComponents(manifest) {
  if (!manifest || !Array.isArray(manifest.components)) {
    return new Map();
  }

  return new Map(
    manifest.components
      .filter((component) => typeof component?.id === "string")
      .map((component) => [component.id, component]),
  );
}

export function buildRemoteComponentDefinitions(platformKey) {
  const baseComponents = [
    {
      id: "server-bundle",
      semanticPrefix: version,
      mount: "server",
      sourcePath: join(releaseDir, "server"),
    },
    {
      id: "node-runtime",
      semanticPrefix: nodeVersion,
      mount: joinPosix("node", platformKey),
      sourcePath: join(releaseDir, "node", platformKey),
    },
    {
      id: "node-pty",
      // node-pty 组件之前固定成 v1，平台包升级后客户端仍会命中旧 cache。
      // 这里使用实际复制来源包的版本，让 @lydell/node-pty-<platform> 升级时组件 cache 自动失效。
      semanticPrefix: resolveNodePtyPackageVersion(platformKey),
      mount: joinPosix("node-pty", platformKey),
      sourcePath: join(releaseDir, "node-pty", platformKey),
    },
    {
      id: "glm",
      // Agent bundle 的版本来自 CLI 构建输入，不沿用旧原生运行时描述符。
      semanticPrefix: agentVersion,
      mount: joinPosix("glm", platformKey),
      sourcePath: join(releaseDir, "glm", platformKey),
    },
  ];

  const [platform, arch] = platformKey.split("-");
  const nativeSearchPlan = resolveRemoteNativeSearchPrebuiltPlan({
    platform,
    arch,
    outputDir: join(releaseDir, "tools", platformKey),
  });

  return [
    ...baseComponents,
    ...nativeSearchPlan.artifacts
      .toSorted((left, right) => left.toolId.localeCompare(right.toolId))
      .map((artifact) => ({
        id: artifact.toolId,
        semanticPrefix: artifact.release,
        mount: joinPosix("tools", platformKey, artifact.toolId),
        sourcePath: dirname(artifact.binaryPath),
      })),
  ];
}

function tryReuseRemoteComponentArtifact({
  mockCdnDir,
  component,
  previousComponent,
  sourceSha256,
}) {
  if (!previousComponent) {
    return null;
  }

  if (previousComponent.id !== component.id || previousComponent.mount !== component.mount) {
    return null;
  }

  if (
    resolveComponentSemanticVersion(previousComponent.version) !==
    buildComponentVersion(component.semanticPrefix)
  ) {
    return null;
  }

  if (previousComponent.sourceSha256 !== sourceSha256) {
    return null;
  }

  if (
    typeof previousComponent.artifactPath !== "string" ||
    typeof previousComponent.sha256 !== "string" ||
    !isSha256(previousComponent.sha256)
  ) {
    return null;
  }

  const artifactPath = join(mockCdnDir, ...previousComponent.artifactPath.split("/"));
  if (!existsSync(artifactPath)) {
    return null;
  }

  if (computeFileSha256(artifactPath) !== previousComponent.sha256) {
    return null;
  }

  return previousComponent;
}

export function prepareRemoteComponentArtifact({
  mockCdnDir,
  platformKey,
  component,
  previousComponents = new Map(),
}) {
  if (!existsSync(component.sourcePath)) {
    throw new Error(
      `Missing component source for ${component.id} (${platformKey}): ${component.sourcePath}`,
    );
  }

  const sourceSha256 = computeComponentSourceSha256(component.sourcePath);
  const previousComponent = previousComponents.get(component.id);
  const reusedComponent = tryReuseRemoteComponentArtifact({
    mockCdnDir,
    component,
    previousComponent,
    sourceSha256,
  });
  if (reusedComponent) {
    // remote mock-cdn 组件源内容没变时不能每次重打 tar.gz。
    // 这里用源目录内容指纹命中已有 manifest 和 artifact，避免 bootstrap:with-remote 重复压缩大组件。
    console.log(`  [skip] component ${component.id} ${platformKey} unchanged`);
    return reusedComponent;
  }

  const semanticComponentVersion = buildComponentVersion(component.semanticPrefix);
  const stagingArtifactRelativePath = joinPosix(
    "components",
    platformKey,
    component.id,
    `${semanticComponentVersion}.tmp-${process.pid}-${Date.now()}.tar.gz`,
  );
  const stagingArtifactPath = join(mockCdnDir, ...stagingArtifactRelativePath.split("/"));
  mkdirSync(dirname(stagingArtifactPath), { recursive: true });

  // 同版本本地重跑时继续复用旧 tar 会让 manifest sha256 指向陈旧内容。
  // 这里先打临时包再把内容 hash 写进最终文件名，避免 CDN 缓存继续命中同名旧对象。
  packComponentSourceAsArchive(component.sourcePath, stagingArtifactPath);
  const artifactSha256 = computeFileSha256(stagingArtifactPath);
  const componentVersion = buildContentAddressedComponentVersion(
    component.semanticPrefix,
    artifactSha256,
  );
  const artifactRelativePath = buildComponentArtifactRelativePath(
    platformKey,
    component.id,
    componentVersion,
  );
  const artifactPath = join(mockCdnDir, ...artifactRelativePath.split("/"));
  if (artifactPath !== stagingArtifactPath) {
    rmSync(artifactPath, { force: true });
    mkdirSync(dirname(artifactPath), { recursive: true });
    renameSync(stagingArtifactPath, artifactPath);
  }
  console.log(`  [component] ${component.id} ${platformKey} -> ${artifactRelativePath}`);

  return {
    id: component.id,
    version: componentVersion,
    sha256: artifactSha256,
    sourceSha256,
    artifactPath: artifactRelativePath,
    mount: component.mount,
  };
}

function prepareRemoteComponentArtifacts() {
  console.log("==> Packaging component artifacts and manifests");

  const componentRootDir = join(mockCdnDir, "components");
  mkdirSync(componentRootDir, { recursive: true });

  for (const platformKey of remotePlatforms) {
    const componentManifestEntries = [];
    const componentDefinitions = buildRemoteComponentDefinitions(platformKey);
    const previousComponents = normalizeManifestComponents(
      readJsonFile(join(releaseDir, `manifest-${platformKey}.json`)),
    );

    for (const component of componentDefinitions) {
      componentManifestEntries.push(
        prepareRemoteComponentArtifact({
          mockCdnDir,
          platformKey,
          component,
          previousComponents,
        }),
      );
    }

    const manifestPath = join(releaseDir, `manifest-${platformKey}.json`);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: componentSchemaVersion,
          appVersion: version,
          platformArch: platformKey,
          components: componentManifestEntries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`  [ok] mock-cdn releases/${version}/manifest-${platformKey}.json`);
  }
}

async function main() {
  console.log(`==> Preparing mock CDN release in ${releaseDir}`);

  mkdirSync(releaseDir, { recursive: true });
  // 旧 manifest 不能在构建失败后伪装为本次完整产物；发布标记最后生成。
  for (const platform of remotePlatforms) {
    await rm(join(releaseDir, `manifest-${platform}.json`), { force: true });
  }

  await prepareNodeBinaries();
  buildServerBundle();
  copyServerBundle();
  copyNodePtyPrebuilds();
  await stageRemoteAgentBundles();
  await prepareRemoteNativeSearchTools();
  // 修复：server、pty、agent 均可独立下载，需在组件哈希计算前补齐各自的声明。
  await stageThirdPartyNotices(join(releaseDir, "server"), rootDir);
  for (const platformKey of remotePlatforms) {
    await stageThirdPartyNotices(join(releaseDir, "node-pty", platformKey), rootDir);
    await stageThirdPartyNotices(join(releaseDir, "glm", platformKey), rootDir);
  }
  prepareRemoteComponentArtifacts();
  await bundleRepositoryRemoteAssets(rootDir);

  console.log(`==> Done! Mock CDN release ready at ${releaseDir}`);
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  await main();
}
