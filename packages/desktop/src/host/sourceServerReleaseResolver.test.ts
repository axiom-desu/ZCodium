import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  hostInitLocalMessageSchema,
} from "@zcode/shared";
import {
  resolveSourceServerReleaseAsset,
  resolveSourceServerReleaseRuntimeOptions,
} from "./sourceServerReleaseResolver.js";

const cleanup: Array<() => Promise<void> | void> = [];
const VERSION = "3.16.2";
const ARCHIVE = Buffer.from("source-server-archive-bytes");
const SHA256 = createHash("sha256").update(ARCHIVE).digest("hex");
const FILE_NAME = "zcode-server-linux-x64.tar.gz";

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function descriptor(version = VERSION) {
  return {
    schemaVersion: 1,
    version,
    archives: [
      {
        target: "linux-x64",
        version,
        fileName: FILE_NAME,
        sha256: SHA256,
        sizeBytes: ARCHIVE.length,
        urls: [FILE_NAME],
      },
    ],
  };
}

async function startReleaseServer(
  input: { descriptor?: unknown; archive?: Buffer; fail?: boolean } = {},
): Promise<{ baseUrl: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (input.fail) {
      response.statusCode = 503;
      response.end();
      return;
    }
    if (request.url === `/${SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(input.descriptor ?? descriptor()));
      return;
    }
    if (request.url === `/${FILE_NAME}`) {
      response.end(input.archive ?? ARCHIVE);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server failed");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(close);
  return { baseUrl, requests, close };
}

describe("SourceServerReleaseResolver", () => {
  it("preserves the same bundled asset path through validated Local Host initialization", () => {
    const remoteAssets = {
      bundledRemoteAssetsDir: join("fixture resources", "remote-assets"),
      sourceServerArtifactPolicy: "development-content-addressed",
    };
    const message = hostInitLocalMessageSchema.parse({
      type: "init-local",
      zcodeBuiltinProviderConfigFilePath: "fixture-provider.json",
      remoteAssets,
    });
    expect(message).toHaveProperty("remoteAssets", remoteAssets);
    expect(() =>
      hostInitLocalMessageSchema.parse({
        type: "init-local",
        zcodeBuiltinProviderConfigFilePath: "fixture-provider.json",
        remoteAssets: { bundledRemoteAssetsDir: 12 },
      }),
    ).toThrow();
  });
  it("consumes Main's relocated bundledRemoteAssetsDir independently of cwd without network", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-host-resources-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const bundledRemoteAssetsDir = join(root, "resources with spaces", "remote-assets");
    const releaseDir = join(bundledRemoteAssetsDir, "releases", VERSION);
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
      join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME),
      JSON.stringify(descriptor()),
    );
    await writeFile(join(releaseDir, FILE_NAME), ARCHIVE);
    const runtime = await resolveSourceServerReleaseRuntimeOptions({
      expectedVersion: VERSION,
      bundledRemoteAssetsDir,
      cwd: join(root, "unrelated working directory"),
      env: {},
    });
    expect(runtime).toMatchObject({
      localReleaseDir: releaseDir,
      artifactPolicy: "development-content-addressed",
    });
    const fetchImpl = vi.fn();
    const asset = await resolveSourceServerReleaseAsset(
      { platform: "linux", arch: "x64" },
      undefined,
      { ...runtime, fetchImpl },
    );
    expect(asset.localArchivePath).toBe(join(releaseDir, FILE_NAME));
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      resolveSourceServerReleaseAsset({ platform: "darwin", arch: "arm64" }, undefined, runtime),
    ).rejects.toMatchObject({ code: "remote-download-failed" });
  });

  it("keeps explicit overrides and requested development policy; missing bundle cannot fall back to CDN", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-host-release-options-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME),
      JSON.stringify(descriptor()),
    );
    const runtime = await resolveSourceServerReleaseRuntimeOptions({
      expectedVersion: VERSION,
      bundledRemoteAssetsDir: join(root, "missing-bundle"),
      cwd: join(root, "unrelated"),
      env: { ZCODE_SOURCE_SERVER_RELEASE_DIR: root },
      cdnBaseUrl: "http://127.0.0.1:1",
      requestedArtifactPolicy: "development-content-addressed",
    });
    expect(runtime.localReleaseDir).toBe(root);
    const missing = await resolveSourceServerReleaseRuntimeOptions({
      expectedVersion: VERSION,
      bundledRemoteAssetsDir: join(root, "missing-bundle"),
      cwd: join(root, "unrelated"),
      env: {},
      cdnBaseUrl: "http://127.0.0.1:1",
      requestedArtifactPolicy: "development-content-addressed",
    });
    const fetchImpl = vi.fn();
    await expect(
      resolveSourceServerReleaseAsset({ platform: "linux", arch: "x64" }, undefined, {
        ...missing,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "remote-download-failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("downloads the fork descriptor and archive from a loopback fixture, then serves the verified cache", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "zcode-source-release-"));
    cleanup.push(() => rm(cacheRoot, { recursive: true, force: true }));
    const release = await startReleaseServer();

    const first = await resolveSourceServerReleaseAsset(
      { platform: "linux", arch: "x64" },
      undefined,
      {
        expectedVersion: VERSION,
        artifactPolicy: "release-versioned",
        releaseBaseUrls: [release.baseUrl],
        cacheRoot,
      },
    );
    expect(first).toMatchObject({
      target: "linux-x64",
      version: VERSION,
      sha256: SHA256,
      sizeBytes: ARCHIVE.length,
    });
    expect(await readFile(first.localArchivePath!, "utf8")).toBe(ARCHIVE.toString());
    expect(release.requests).toEqual([
      `/${SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME}`,
      `/${FILE_NAME}`,
    ]);

    release.requests.length = 0;
    const second = await resolveSourceServerReleaseAsset(
      { platform: "linux", arch: "x64" },
      undefined,
      {
        expectedVersion: VERSION,
        artifactPolicy: "release-versioned",
        releaseBaseUrls: [release.baseUrl],
        cacheRoot,
      },
    );
    expect(second.localArchivePath).toBe(first.localArchivePath);
    // 同一版本缓存命中前重新校验 size/sha；不再重复下载。
    expect(release.requests).toEqual([`/${SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME}`]);
  });

  it("rejects a descriptor for another version instead of falling back to upstream content", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "zcode-source-release-"));
    cleanup.push(() => rm(cacheRoot, { recursive: true, force: true }));
    const release = await startReleaseServer({ descriptor: descriptor("9.9.9") });

    await expect(
      resolveSourceServerReleaseAsset({ platform: "linux", arch: "x64" }, undefined, {
        expectedVersion: VERSION,
        artifactPolicy: "release-versioned",
        releaseBaseUrls: [release.baseUrl],
        cacheRoot,
      }),
    ).rejects.toMatchObject({ code: "remote-download-failed" });
  });

  it("uses only the local descriptor under development content-addressed policy", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-source-local-"));
    cleanup.push(() => rm(releaseDir, { recursive: true, force: true }));
    await writeFile(
      join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME),
      JSON.stringify(descriptor()),
    );
    await writeFile(join(releaseDir, FILE_NAME), ARCHIVE);

    const asset = await resolveSourceServerReleaseAsset(
      { platform: "linux", arch: "x64" },
      undefined,
      {
        expectedVersion: VERSION,
        artifactPolicy: "development-content-addressed",
        localReleaseDir: releaseDir,
      },
    );
    expect(asset.localArchivePath).toBe(join(releaseDir, FILE_NAME));
    expect(asset.sha256).toBe(SHA256);
  });

  it("fails explicitly when development policy has no local release", async () => {
    await expect(
      resolveSourceServerReleaseAsset({ platform: "linux", arch: "x64" }, undefined, {
        expectedVersion: VERSION,
        artifactPolicy: "development-content-addressed",
        releaseBaseUrls: ["http://127.0.0.1:1"],
      }),
    ).rejects.toMatchObject({ code: "remote-download-failed" });
  });

  it("rejects an archive whose bytes do not match the descriptor", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-source-local-"));
    cleanup.push(() => rm(releaseDir, { recursive: true, force: true }));
    await writeFile(
      join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME),
      JSON.stringify(descriptor()),
    );
    await writeFile(join(releaseDir, FILE_NAME), Buffer.from("tampered"));

    await expect(
      resolveSourceServerReleaseAsset({ platform: "linux", arch: "x64" }, undefined, {
        expectedVersion: VERSION,
        artifactPolicy: "development-content-addressed",
        localReleaseDir: releaseDir,
      }),
    ).rejects.toMatchObject({ code: "remote-download-failed" });
  });

  it("falls back to the version-bound descriptor cache when the release host is offline", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "zcode-source-release-"));
    cleanup.push(() => rm(cacheRoot, { recursive: true, force: true }));
    const release = await startReleaseServer();
    await resolveSourceServerReleaseAsset({ platform: "linux", arch: "x64" }, undefined, {
      expectedVersion: VERSION,
      artifactPolicy: "release-versioned",
      releaseBaseUrls: [release.baseUrl],
      cacheRoot,
    });
    await release.close();
    const offline = await startReleaseServer({ fail: true });
    const asset = await resolveSourceServerReleaseAsset(
      { platform: "linux", arch: "x64" },
      undefined,
      {
        expectedVersion: VERSION,
        artifactPolicy: "release-versioned",
        releaseBaseUrls: [offline.baseUrl],
        cacheRoot,
      },
    );
    expect(asset.version).toBe(VERSION);
    expect(await readFile(asset.localArchivePath!, "utf8")).toBe(ARCHIVE.toString());
  });

  it.each([
    { platform: "win32", arch: "x64" },
    { platform: "linux", arch: "ia32" },
    { platform: "freebsd", arch: "arm64" },
  ])("unsupported target %j fails with public code before artifact IO", async (probe) => {
    const fetchImpl = vi.fn();
    await expect(
      resolveSourceServerReleaseAsset(probe, undefined, {
        expectedVersion: VERSION,
        artifactPolicy: "release-versioned",
        releaseBaseUrls: ["http://127.0.0.1:1"],
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "remote-platform-unsupported", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsupported probe targets even without artifact configuration", async () => {
    await expect(
      resolveSourceServerReleaseAsset({ platform: "win32", arch: "x64" }, undefined, {
        expectedVersion: VERSION,
        artifactPolicy: "release-versioned",
      }),
    ).rejects.toMatchObject({ code: "remote-platform-unsupported", retryable: false });
  });
});
