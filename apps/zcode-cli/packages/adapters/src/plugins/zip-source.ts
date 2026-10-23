export { PluginZipDownloadError } from "./zip-source-core.js";
export type { ResolvedZipPluginSourceRoot } from "./zip-source-core.js";
import { downloadZipArchive, extractZipArchive } from "./zip-source-archive.js";
import {
  resolveZipRoot,
  validateZipHeaders,
  normalizeZipRelativePath,
  validateZipDownloadUrl,
} from "./zip-source-paths.js";
import {
  ZIP_REQUIRED_SHA256_PATTERN,
  ZIP_TEMP_PREFIX,
  throwIfAborted,
  type ResolveHttpZipSourceInput,
  type ResolveZipPluginSourceInput,
  type ResolvedZipPluginSourceRoot,
} from "./zip-source-core.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort } from "./helpers.js";

export async function resolveZipPluginSource(
  input: ResolveZipPluginSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipSourceInput(input);
  const resolved = await resolveHttpZipSource({
    headers: input.headers,
    path: input.path,
    sha256: input.sha256,
    signal: input.signal,
    stripRoot: input.stripRoot,
    url: input.url,
  });
  return resolved;
}

export async function resolveHttpZipSource(
  input: ResolveHttpZipSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  validateZipDownloadUrl(input.url);
  validateZipHeaders(input.headers);
  if (input.path !== undefined) normalizeZipRelativePath(input.path);
  if (input.sha256 !== undefined && !ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new Error("Plugin zip source sha256 must be a 64 character hex string");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), ZIP_TEMP_PREFIX));
  const archivePath = join(tempRoot, "source.zip");
  const extractRoot = join(tempRoot, "extract");
  const cleanup = async (): Promise<void> => {
    await rm(tempRoot, { force: true, recursive: true });
  };

  try {
    throwIfAborted(input.signal);
    const zipBytes = await downloadZipArchive({
      headers: input.headers,
      signal: input.signal,
      url: input.url,
    });
    const actualSha256 = createHash("sha256").update(zipBytes).digest("hex");
    if (input.sha256 !== undefined && actualSha256 !== input.sha256.toLowerCase()) {
      throw new Error(
        `Plugin zip sha256 mismatch: expected=${input.sha256.toLowerCase()}, actual=${actualSha256}`,
      );
    }

    await writeFile(archivePath, zipBytes);
    const extracted = await extractZipArchive({
      archivePath,
      signal: input.signal,
      targetRoot: extractRoot,
    });
    const pluginRoot = resolveZipRoot({
      extractRoot,
      path: input.path,
      requireSingleRoot: input.requireSingleRoot,
      stripRoot: input.stripRoot,
      topLevelSegments: extracted.topLevelSegments,
    });
    return { cleanup, path: pluginRoot };
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

export function readZipPluginSourceSha256(source: unknown): string | undefined {
  if (!isZipPluginUrlSource(source)) return undefined;
  return source.sha256;
}

export function isZipPluginUrlSource(
  source: unknown,
): source is { source: "url"; type: "zip"; sha256: string; url: string } {
  return (
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source) &&
    "source" in source &&
    (source as { source?: unknown }).source === "url" &&
    (source as { type?: unknown }).type === "zip" &&
    typeof (source as { url?: unknown }).url === "string" &&
    typeof (source as { sha256?: unknown }).sha256 === "string"
  );
}

function validateZipSourceInput(input: ResolveZipPluginSourceInput): void {
  validateZipDownloadUrl(input.url);
  if (!ZIP_REQUIRED_SHA256_PATTERN.test(input.sha256.toLowerCase())) {
    throw new Error("Plugin zip source sha256 must be a 64 character hex string");
  }
  validateZipHeaders(input.headers);
  if (input.path !== undefined) {
    normalizeZipRelativePath(input.path);
  }
}
