import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  normalizeRemoteConnectionError,
  sourceServerReleaseDescriptorSchema,
  type RemoteTarget,
  type SourceServerArtifactPolicy,
  type SourceServerReleaseArchive,
  type SourceServerReleaseDescriptor,
} from "@zcode/shared";
import type { ServerReleaseAsset } from "@zcode/server/source-server";

export interface SourceServerReleaseFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** 生产走全局 fetch；测试注入 loopback fixture fetch。 */
export type SourceServerReleaseFetch = (url: string) => Promise<SourceServerReleaseFetchResponse>;

export interface SourceServerReleaseResolverOptions {
  /** 本仓 fork 的构建版本；descriptor 必须与它完全一致，禁止回退上游制品。 */
  expectedVersion: string;
  artifactPolicy: SourceServerArtifactPolicy;
  /** 本轮 staging 写出的本地 descriptor/archive 目录（开发/内容寻址策略使用）。 */
  localReleaseDir?: string;
  /** 显式 fork 发布版本的 base URL（每个 base 指向 `.../releases/<version>`）。 */
  releaseBaseUrls?: string[];
  cacheRoot?: string;
  fetchImpl?: SourceServerReleaseFetch;
}

function supportedTarget(probe: {
  platform: string;
  arch: string;
}): "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" {
  const target = `${probe.platform}-${probe.arch}`;
  if (
    target !== "linux-x64" &&
    target !== "linux-arm64" &&
    target !== "darwin-x64" &&
    target !== "darwin-arm64"
  ) {
    throw new Error(`Unsupported Source Server release target: ${target}`);
  }
  return target;
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function verifyArchive(path: string, archive: SourceServerReleaseArchive): Promise<boolean> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size !== archive.sizeBytes) return false;
  return (await sha256File(path)) === archive.sha256;
}

function readDescriptor(text: string, expectedVersion: string): SourceServerReleaseDescriptor {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(text));
  if (descriptor.version !== expectedVersion) {
    throw new Error(
      `Source Server descriptor version mismatch: expected ${expectedVersion}, received ${descriptor.version}`,
    );
  }
  return descriptor;
}

function findArchive(
  descriptor: SourceServerReleaseDescriptor,
  target: SourceServerReleaseArchive["target"],
): SourceServerReleaseArchive {
  const archive = descriptor.archives.find((candidate) => candidate.target === target);
  if (!archive) throw new Error(`Source Server descriptor is missing target: ${target}`);
  return archive;
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function resolveLocalRelease(
  releaseDir: string,
  target: SourceServerReleaseArchive["target"],
  expectedVersion: string,
): Promise<{ archive: SourceServerReleaseArchive; archivePath: string } | null> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  if (!(await pathExists(descriptorPath))) return null;
  const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"), expectedVersion);
  const archive = findArchive(descriptor, target);
  const archivePath = join(releaseDir, archive.fileName);
  if (!(await verifyArchive(archivePath, archive))) {
    throw new Error(`Source Server local archive failed descriptor verification: ${archivePath}`);
  }
  return { archive, archivePath };
}

function resolveAbsoluteUrl(base: string, relative: string): string {
  if (/^https?:\/\//u.test(relative)) return relative;
  return `${base.replace(/\/+$/u, "")}/${relative.replace(/^\/+/u, "")}`;
}

async function fetchDescriptor(
  releaseBaseUrls: string[],
  cacheRoot: string | null,
  expectedVersion: string,
  fetchImpl: SourceServerReleaseFetch,
): Promise<{ descriptor: SourceServerReleaseDescriptor; releaseBases: string[] }> {
  const cachedDescriptorPath = cacheRoot
    ? join(cacheRoot, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)
    : null;
  let lastError: unknown;
  for (const base of releaseBaseUrls) {
    const url = resolveAbsoluteUrl(base, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const descriptor = readDescriptor(text, expectedVersion);
      if (cachedDescriptorPath) await writeTextAtomic(cachedDescriptorPath, text);
      return { descriptor, releaseBases: releaseBaseUrls };
    } catch (error) {
      lastError = error;
    }
  }
  // 只有版本完全一致的缓存 descriptor 才可作为离线回退；不信任其它版本/上游内容。
  if (cachedDescriptorPath && (await pathExists(cachedDescriptorPath))) {
    return {
      descriptor: readDescriptor(await readFile(cachedDescriptorPath, "utf8"), expectedVersion),
      releaseBases: releaseBaseUrls,
    };
  }
  throw new Error("Unable to resolve Source Server release descriptor", { cause: lastError });
}

async function downloadArchive(
  archive: SourceServerReleaseArchive,
  releaseBases: string[],
  cacheRoot: string,
  fetchImpl: SourceServerReleaseFetch,
): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const cached = join(cacheRoot, archive.fileName);
  if (await verifyArchive(cached, archive)) return cached;
  await rm(cached, { force: true });
  const urls = Array.from(
    new Set(
      archive.urls.map((url) =>
        /^https?:\/\//u.test(url) ? url : resolveAbsoluteUrl(releaseBases[0] ?? "", url),
      ),
    ),
  ).filter((url) => /^https?:\/\//u.test(url));
  let lastError: unknown;
  for (const url of urls) {
    const temporary = `${cached}.${process.pid}.tmp`;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(temporary, buffer, { mode: 0o600 });
      if (!(await verifyArchive(temporary, archive))) {
        throw new Error(`Source Server archive checksum mismatch: ${archive.fileName}`);
      }
      await rename(temporary, cached);
      return cached;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Unable to download Source Server release ${archive.fileName}`, {
    cause: lastError,
  });
}

async function resolveReleaseAsset(
  probe: { platform: string; arch: string },
  target: Exclude<RemoteTarget, { kind: "server" }> | undefined,
  options: SourceServerReleaseResolverOptions,
): Promise<ServerReleaseAsset> {
  const releaseTarget = supportedTarget(probe);
  const version = options.expectedVersion;
  if (!version.trim()) throw new Error("Source Server expected version is required");
  const versionCacheRoot = options.cacheRoot
    ? join(options.cacheRoot, "source-server", version)
    : null;

  // 内容寻址开发策略只消费本轮本地 descriptor/archive；缺失必须显式失败，
  // 不能回退 CDN 把 bootstrap/staging 失败伪装成成功。
  if (options.artifactPolicy === "development-content-addressed") {
    if (!options.localReleaseDir) {
      throw new Error(
        "Development Source Server release is unavailable; run the remote asset bootstrap",
      );
    }
    const local = await resolveLocalRelease(options.localReleaseDir, releaseTarget, version);
    if (!local) {
      throw new Error(
        "Development Source Server release descriptor is unavailable; run the remote asset bootstrap",
      );
    }
    return {
      localArchivePath: local.archivePath,
      target: releaseTarget,
      version,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  // 版本化发布：优先使用显式本地目录（staging 产物），再走 fork 的 CDN base。
  if (options.localReleaseDir) {
    const local = await resolveLocalRelease(options.localReleaseDir, releaseTarget, version);
    if (local) {
      return {
        localArchivePath: local.archivePath,
        target: releaseTarget,
        version,
        sha256: local.archive.sha256,
        sizeBytes: local.archive.sizeBytes,
        urls: local.archive.urls,
      };
    }
  }

  const releaseBases = options.releaseBaseUrls?.filter((url) => url.trim().length > 0) ?? [];
  if (releaseBases.length === 0) {
    throw new Error(
      "Source Server release base is not configured; refusing to fall back to the upstream artifact source",
    );
  }
  if (!versionCacheRoot) {
    throw new Error("Source Server release cache is unavailable");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = await fetchDescriptor(releaseBases, versionCacheRoot, version, fetchImpl);
  const archive = findArchive(resolved.descriptor, releaseTarget);
  const localArchivePath = await downloadArchive(
    archive,
    resolved.releaseBases,
    versionCacheRoot,
    fetchImpl,
  );
  return {
    localArchivePath,
    target: releaseTarget,
    version,
    sha256: archive.sha256,
    sizeBytes: archive.sizeBytes,
    urls: archive.urls,
  };
}

/**
 * 解析本仓 fork 的 Source Server 安装制品。
 * 失败统一归一为可公开的 remote-* 错误码，避免原始 URL/host/path 泄漏到日志。
 */
export async function resolveSourceServerReleaseAsset(
  probe: { platform: string; arch: string },
  target: Exclude<RemoteTarget, { kind: "server" }> | undefined,
  options: SourceServerReleaseResolverOptions,
): Promise<ServerReleaseAsset> {
  try {
    return await resolveReleaseAsset(probe, target, options);
  } catch (error) {
    const failure = normalizeRemoteConnectionError(error, "download");
    throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
  }
}
