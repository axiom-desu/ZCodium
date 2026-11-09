#!/usr/bin/env node
/**
 * 远端首次连接冒烟：用公开入口产出真实制品，并验证 安装 → daemon → 鉴权 → Host RPC。
 *
 * 为什么单独成入口：prepare/bundle/resolver 任何一环断掉，用户都会在“确认安装”后卡住，
 * 而单元测试只验证各段字符串。这里必须跑真实字节与真实子进程。
 *
 * 入口自身隔离 HOME/XDG/应用数据目录，且在加载会触发业务 IO 的模块之前完成。
 * 只覆盖本机 linux-x64 制品；真实 SSH/WSL/Docker 与模型首条消息不在本文件范围内。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

// 必须在任何业务模块 import 之前落实隔离：这些模块在导入期就会解析用户目录。
const root = await mkdtemp(join(tmpdir(), "zcode-first-connect-"));
const isolatedHome = join(root, "home");
const isolatedEnv = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  APPDATA: join(root, "config"),
  LOCALAPPDATA: join(root, "data"),
  ZCODE_DATA_BASE_DIR: join(root, "data"),
  ZCODE_SERVER_ROOT: join(root, "server-root"),
  ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
  NODE_OPTIONS: "",
  NODE_PATH: "",
};
delete isolatedEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
delete isolatedEnv.ZCODE_SOURCE_SERVER_RELEASE_DIR;
Object.assign(process.env, isolatedEnv);
await mkdir(isolatedHome, { recursive: true });

const target = "linux-x64";
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(
    `This smoke currently covers ${target} only, got ${process.platform}-${process.arch}`,
  );
}

const exec = (command, args, options = {}) =>
  run(command, args, {
    cwd: root,
    env: isolatedEnv,
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });

const tsImport = async (path) => await import(pathToFileURL(join(repositoryRoot, path)).href);

const { tsImport: tsxImport } = await import(
  pathToFileURL(join(repositoryRoot, "node_modules/tsx/dist/esm/api/index.mjs")).href
);
const shared = await tsxImport(
  join(repositoryRoot, "packages/shared/src/builtinPluginAssets.ts"),
  import.meta.url,
);
const { prepareRemoteNode, REMOTE_NODE_VERSION } = await tsImport(
  "scripts/remote-node-runtime.mjs",
);
const { prepareRemoteNativeSearchTools } = await tsImport("scripts/prepare-prebuilds.mjs");
const { stageCuaDriverRuntime } = await tsImport("scripts/cua-driver-runtime-assets.mjs");
const { readThirdPartyNotices, readNodeNotices } = await tsImport(
  "scripts/third-party-notices.mjs",
);
const { workspacePackageDirectories } = await tsImport("scripts/prepare-source-server-release.mjs");
const { collectRollingAppVersion } = await tsImport("scripts/rolling-app-version.mjs");
const { resolveSourceServerReleaseRuntimeOptions, resolveSourceServerReleaseAsset } =
  await tsxImport(
    join(repositoryRoot, "packages/desktop/src/host/sourceServerReleaseResolver.ts"),
    import.meta.url,
  );
const { connectServerRemote } = await tsxImport(
  join(repositoryRoot, "packages/desktop/src/host/serverRemoteConnection.ts"),
  import.meta.url,
);

const version = collectRollingAppVersion().appVersion;
/** prepare 随包的目标 Node；用于在 staging 目录内真实执行 CLI。 */
const nodeBinary = () => join(root, "node/node");
const agentBundlePath = join(repositoryRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
let connection;
let node;
let cli;

const steps = [];
const record = (name, detail = {}) => {
  steps.push({ name, ...detail });
  console.log(`  [ok] ${name}`, Object.keys(detail).length > 0 ? JSON.stringify(detail) : "");
};

try {
  console.log(`first-connect smoke root=${root} version=${version}`);

  // 1. 真实构建产物：不能用仓库里可能过期的 dist 冒充。
  const distDir = join(root, "dist");
  await exec(
    process.execPath,
    [
      join(repositoryRoot, "node_modules/tsup/dist/cli-default.js"),
      "--config",
      join(repositoryRoot, "packages/zcode-server-cli/tsup.config.ts"),
      "--out-dir",
      distDir,
    ],
    // tsup 的 entry 相对 cwd 解析；必须在包目录下构建。
    { cwd: join(repositoryRoot, "packages/zcode-server-cli") },
  );
  const builtSize = (await stat(join(distDir, "server-cli.js"))).size;
  if (builtSize === 0) throw new Error("fresh server-cli build is empty");
  // dist 单独执行时没有相邻 node_modules 闭包，这不是可用形态；版本以 staging 后的真实产物为准。
  record("fresh server-cli build produced", { bytes: builtSize });

  // 2. 公开 prepare 的真实输入：随包 Node、搜索工具、官方插件（含 CUA 闭包）、Agent。
  await prepareRemoteNode({
    platform: target,
    outputDirectory: join(root, "node"),
    cacheDirectory: join(repositoryRoot, ".cache/remote-node"),
    root: repositoryRoot,
  });
  await prepareRemoteNativeSearchTools({ platforms: [target], outputDir: join(root, "tools") });
  const officialPluginsDir = join(root, "plugins");
  for (const plugin of shared.BUILTIN_PLUGIN_ASSETS) {
    const source = join(repositoryRoot, plugin.relativePath);
    const destination = join(officialPluginsDir, plugin.directory);
    await mkdir(destination, { recursive: true });
    for (const name of shared.BUILTIN_PLUGIN_TOP_LEVEL_PATHS) {
      await cp(join(source, name), join(destination, name), {
        recursive: true,
        filter: (path) =>
          path === join(source, name) ||
          (!["node_modules", ".venv", "__pycache__", ".DS_Store"].includes(basename(path)) &&
            !path.endsWith(".pyc")),
      }).catch((error) => {
        // 顶层清单允许缺省项；缺失的运行资产交给 prepare 的 fail-closed 校验报错。
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  await stageCuaDriverRuntime(join(officialPluginsDir, "node-repl-host"), {
    platform: "linux",
    arch: "x64",
  });
  const agentStat = await stat(agentBundlePath).catch(() => null);
  if (!agentStat?.isFile()) {
    throw new Error(
      `Missing Agent bundle: ${agentBundlePath}. Run the Agent build before this smoke; it must not be skipped.`,
    );
  }
  const [thirdParty, nodeNotice, workspacePackageDirs] = await Promise.all([
    readThirdPartyNotices(repositoryRoot),
    readNodeNotices(REMOTE_NODE_VERSION, repositoryRoot),
    workspacePackageDirectories(repositoryRoot),
  ]);
  const prepareConfig = join(root, "prepare-inputs.json");
  await writeFile(
    prepareConfig,
    JSON.stringify({
      target,
      appVersion: version,
      distDir,
      agentBundlePath,
      bundledSkillsDir: join(repositoryRoot, "apps/zcode-cli/packages/bundled-skills"),
      nodeBinaryPath: join(root, "node/node"),
      workspaceNodeModulesDir: join(repositoryRoot, "node_modules"),
      workspacePackageDirs: Object.fromEntries(workspacePackageDirs),
      officialPluginsDir,
      nativeToolsDir: join(root, "tools", target),
      notices: {
        thirdParty: thirdParty.toString("utf8"),
        node: nodeNotice.bytes.toString("utf8"),
        nodeSource: JSON.stringify(nodeNotice.source),
      },
      outputDir: join(root, "cdn", "releases", version),
      componentArchives: false,
    }),
  );
  record("prepared real inputs", { target, agentBytes: agentStat.size });

  // 3. 公开 prepare/bundle：descriptor 必须由真实归档生成，不能手写。
  await exec(process.execPath, [
    join(repositoryRoot, "scripts/prepare-prebuilds.mjs"),
    "--source-server-config",
    prepareConfig,
  ]);
  const cdnReleaseDir = join(root, "cdn", "releases", version);
  const descriptorText = await readFile(join(cdnReleaseDir, "source-server-release.json"), "utf8");
  const descriptor = JSON.parse(descriptorText);
  const archiveName = descriptor.archives?.[0]?.fileName;
  if (!archiveName) throw new Error("Prepared descriptor has no archive");
  const archivePath = join(cdnReleaseDir, archiveName);
  const archiveHash = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  if (archiveHash !== descriptor.archives[0].sha256) {
    throw new Error("Prepared archive hash does not match its descriptor");
  }
  // staging 会把运行时闭包装到 bundle 旁边，只有这个形态才能真实执行。
  const stagedReleaseDir = join(cdnReleaseDir, "zcode-server-linux-x64");
  const stagedVersion = JSON.parse(
    (
      await exec(nodeBinary(), [
        join(stagedReleaseDir, "runtime/server-cli.js"),
        "--version",
        "--json",
      ])
    ).stdout,
  );
  if (stagedVersion.product !== "zcode-server" || stagedVersion.version !== version) {
    throw new Error(
      `staged CLI version mismatch: expected ${version}, received ${stagedVersion.version}`,
    );
  }
  if (
    !(
      await stat(join(stagedReleaseDir, "runtime/packages/node-repl-host/dist/mcp/server.js"))
    ).isFile()
  ) {
    throw new Error("staged release is missing the node-repl-host runtime");
  }
  record("staged release runs its CLI with the bundled runtime closure", {
    archiveName,
    sizeBytes: descriptor.archives[0].sizeBytes,
    version: stagedVersion.version,
  });

  const bundledAssetsDir = join(root, "installed resources", "remote-assets");
  const bundleConfig = join(root, "bundle-inputs.json");
  await writeFile(
    bundleConfig,
    JSON.stringify({
      sourceDirectory: join(root, "cdn"),
      outputDirectory: bundledAssetsDir,
      version,
    }),
  );
  await exec(process.execPath, [
    join(repositoryRoot, "scripts/bundle-remote-assets.mjs"),
    "--config",
    bundleConfig,
  ]);
  await exec(process.execPath, [
    join(repositoryRoot, "scripts/bundle-remote-assets.mjs"),
    "verify",
    bundledAssetsDir,
    version,
  ]);
  record("public bundle verified bundled assets");

  // 4. Host 侧解析：必须能只凭随包目录找到同版本制品。
  const runtimeOptions = await resolveSourceServerReleaseRuntimeOptions({
    expectedVersion: version,
    bundledRemoteAssetsDir: bundledAssetsDir,
    cwd: root,
    env: {},
  });
  const asset = await resolveSourceServerReleaseAsset(
    { platform: "linux", arch: "x64" },
    undefined,
    runtimeOptions,
  );
  if (!asset.localArchivePath) {
    throw new Error("Host resolver returned no local archive for the bundled asset");
  }
  record("Host resolver resolved the bundled asset", { policy: runtimeOptions.artifactPolicy });

  // 5. 真实安装目录：解包、更新、启动、鉴权、Host RPC。
  const unpack = join(root, "unpack");
  await mkdir(unpack);
  await exec("tar", ["-xzf", asset.localArchivePath, "-C", unpack]);
  const releaseDir = join(unpack, "zcode-server-linux-x64");
  node = join(releaseDir, "runtime/node");
  cli = join(releaseDir, "runtime/server-cli.js");
  const installedVersion = JSON.parse((await exec(node, [cli, "--version", "--json"])).stdout);
  if (installedVersion.version !== version) {
    throw new Error(`installed CLI version mismatch: ${installedVersion.version}`);
  }
  record("bundled Node runs the staged CLI", { version: installedVersion.version });

  await exec(node, [
    cli,
    "update",
    "--from-archive",
    asset.localArchivePath,
    "--server-root",
    isolatedEnv.ZCODE_SERVER_ROOT,
    "--json",
  ]);
  const ready = JSON.parse(
    (
      await exec(node, [
        cli,
        "serve",
        "--daemon",
        "--json",
        "--server-root",
        isolatedEnv.ZCODE_SERVER_ROOT,
      ])
    ).stdout,
  );
  if (ready.state !== "ready" || !(ready.port > 0) || ready.version !== version) {
    throw new Error(`daemon did not become ready: ${JSON.stringify(ready)}`);
  }
  record("daemon ready with ingress port", { port: ready.port, version: ready.version });

  const token = (
    await readFile(join(isolatedEnv.ZCODE_SERVER_ROOT, "run/ingress-token"), "utf8")
  ).trim();
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  const info = await fetch(`${baseUrl}/api/server-info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (info.status !== 200) throw new Error(`server-info failed with ${info.status}`);
  const serverInfo = await info.json();
  if (serverInfo.version !== version) {
    throw new Error(`server-info version mismatch: ${serverInfo.version}`);
  }
  // 匿名 server-info 是刻意的降级描述（只给版本/协议），不能泄漏身份或工作区。
  const anonymous = await fetch(`${baseUrl}/api/server-info`);
  const anonymousInfo = await anonymous.json();
  if (anonymous.status !== 200 || anonymousInfo.authRequired !== true) {
    throw new Error(`anonymous server-info contract changed: ${anonymous.status}`);
  }
  if (anonymousInfo.identity !== undefined || anonymousInfo.workspaces !== undefined) {
    throw new Error("anonymous server-info leaked identity or workspaces");
  }
  record("authenticated server-info keeps anonymous callers on the reduced contract");

  connection = await connectServerRemote({ kind: "server", url: baseUrl, token });
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "first-connect-marker.txt"), "first connect smoke\n");
  const entries = await connection.services.fileService.readdir({ path: workspace });
  if (!entries.some((entry) => entry.name === "first-connect-marker.txt")) {
    throw new Error("Host RPC readdir did not return the workspace marker");
  }
  record("Host RPC reads the remote workspace");

  const agentVersion = (
    await exec(node, [join(releaseDir, "runtime/zcode.cjs"), "--version"])
  ).stdout.trim();
  if (!agentVersion) throw new Error("Agent bundle reported no version");
  record("Agent bundle starts", { agentVersion });

  await exec(node, [cli, "stop", "--server-root", isolatedEnv.ZCODE_SERVER_ROOT, "--json"]).then(
    () => record("daemon stopped"),
    (error) => {
      // 停止失败必须让检查失败：残留 daemon 会污染后续连接。
      throw new Error(`daemon stop failed: ${error.message}`);
    },
  );
  node = undefined;
  cli = undefined;

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        version,
        steps: steps.map((step) => step.name),
        notCovered: [
          "real SSH/WSL/Docker targets",
          "Agent first model message over a loopback provider",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  connection?.dispose();
  if (node && cli) {
    await exec(node, [cli, "stop", "--server-root", isolatedEnv.ZCODE_SERVER_ROOT, "--json"]).catch(
      () => {},
    );
  }
  // 只是测试清理：Supervisor 退出后仍可能短暂删除 run/ 下的 pid/lock 文件，
  // 因此给有界重试等待目录稳定；这不用于掩盖产品侧任何同步或就绪问题。
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
