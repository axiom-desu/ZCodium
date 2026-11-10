import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { verifyArchiveSha256 } from "./remote-node-runtime.mjs";
import { getBuildMetadata } from "../packages/desktop/scripts/build-metadata.mjs";
import {
  verifySourceServerAssets,
  copySourceServerArchives,
  writeSourceServerDescriptor,
} from "./source-server-assets.mjs";

const { BUNDLED_REMOTE_MANIFEST, parseBundledRemoteManifest, remoteComponentRequiredPaths } =
  await tsImport("@zcode/shared/bundled-remote-assets", import.meta.url);
export { remoteComponentRequiredPaths };
const run = promisify(execFile);

async function containedFile(directory, path) {
  const root = await realpath(directory);
  const file = await realpath(join(root, path));
  const rel = relative(root, file);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    !(await stat(file)).isFile()
  ) {
    throw new Error(`Invalid remote component file: ${path}`);
  }
  return file;
}

export async function verifyBundledRemoteAssets(directory, version) {
  // 旧组件齐全并不代表首次安装可用：R3 descriptor/archive 必须始终验证。
  const descriptor = await verifySourceServerAssets(join(directory, "releases", version), version);
  if (!(await stat(join(directory, BUNDLED_REMOTE_MANIFEST)).catch(() => null))) return descriptor;
  const manifest = parseBundledRemoteManifest(
    JSON.parse(await readFile(join(directory, BUNDLED_REMOTE_MANIFEST), "utf8")),
    version,
  );
  for (const component of manifest.components) {
    await verifyArchiveSha256(
      await containedFile(directory, component.artifactPath),
      component.sha256,
    );
  }
  return manifest;
}

export async function bundleRemoteAssets({
  sourceDirectory,
  outputDirectory,
  version,
  sourceCommit,
  sourceDirty = false,
}) {
  const sourceFromOutput = relative(resolve(outputDirectory), resolve(sourceDirectory));
  if (
    !sourceFromOutput ||
    (!isAbsolute(sourceFromOutput) &&
      sourceFromOutput !== ".." &&
      !sourceFromOutput.startsWith(`..${sep}`))
  ) {
    throw new Error("Remote bundle output must not contain the source directory");
  }
  if (!version || version === "." || version === ".." || /[/\\\\]/u.test(version)) {
    throw new Error("Invalid remote bundle version");
  }
  // 失败的重建必须撤销旧发布标记，否则打包脚本可能把上一次产物当作本次成功。
  await rm(outputDirectory, { recursive: true, force: true });
  const releaseDirectory = join(sourceDirectory, "releases", version);
  const descriptor = await verifySourceServerAssets(releaseDirectory, version);
  const bundledReleaseDirectory = join(outputDirectory, "releases", version);
  await copySourceServerArchives(releaseDirectory, bundledReleaseDirectory, descriptor);
  // 旧静态组件仅供已有消费者；不能替代 R3，或在缺 descriptor 时假成功。
  if (!(await stat(join(releaseDirectory, BUNDLED_REMOTE_MANIFEST)).catch(() => null))) {
    await writeSourceServerDescriptor(bundledReleaseDirectory, descriptor);
    return descriptor;
  }
  const source = JSON.parse(
    await readFile(join(releaseDirectory, BUNDLED_REMOTE_MANIFEST), "utf8"),
  );
  const manifest = parseBundledRemoteManifest({ ...source, sourceCommit, sourceDirty }, version);
  for (const component of manifest.components) {
    for (const required of remoteComponentRequiredPaths(component.id)) {
      await containedFile(releaseDirectory, join(component.mount, required)).catch((error) => {
        throw new Error(`Missing remote component input: ${component.id}/${required}`, {
          cause: error,
        });
      });
    }
    const archive = await containedFile(sourceDirectory, component.artifactPath);
    await verifyArchiveSha256(archive, component.sha256);
    const target = join(outputDirectory, component.artifactPath);
    await mkdir(dirname(target), { recursive: true });
    // 复制归档字节而非解包目录，Windows artifact 消费端不会丢 Linux 执行权限。
    await copyFile(archive, target);
    await verifyArchiveSha256(target, component.sha256);
  }
  await mkdir(outputDirectory, { recursive: true });
  const manifestPath = join(outputDirectory, BUNDLED_REMOTE_MANIFEST);
  await writeFile(`${manifestPath}.part`, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(`${manifestPath}.part`, manifestPath);
  await writeSourceServerDescriptor(bundledReleaseDirectory, descriptor);
  return manifest;
}

export async function bundleRepositoryRemoteAssets(root) {
  // 版本串唯一来源：mock-cdn releases/<version> 目录名、manifest.appVersion 与打包侧
  // beforePack 校验、collect 产物名必须同源；读 package.json 会拿到裸基线而找不到目录。
  const { appVersion: version } = getBuildMetadata();
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: root });
  const { stdout: dirty } = await run("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
  });
  return bundleRemoteAssets({
    sourceDirectory: join(root, "packages/desktop/mock-cdn"),
    outputDirectory: join(root, "packages/desktop/bundled-remote-assets"),
    version,
    sourceCommit: stdout.trim(),
    sourceDirty: Boolean(dirty.trim()),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(import.meta.dirname, "..");
  // 与 bundleRepositoryRemoteAssets 同源：verify 的版本串必须等于 manifest.appVersion。
  const { appVersion: version } = getBuildMetadata();
  if (process.argv[2] === "verify" && process.argv.length <= 5) {
    await verifyBundledRemoteAssets(
      resolve(process.argv[3] || join(root, "packages/desktop/bundled-remote-assets")),
      process.argv[4] || version,
    );
  } else if (process.argv[2] === "--config" && process.argv.length === 4) {
    await bundleRemoteAssets(JSON.parse(await readFile(resolve(process.argv[3]), "utf8")));
  } else if (process.argv.length === 2) {
    await bundleRepositoryRemoteAssets(root);
  } else {
    throw new Error(
      "Usage: node scripts/bundle-remote-assets.mjs [verify [directory [version]] | --config <inputs.json>]",
    );
  }
}
