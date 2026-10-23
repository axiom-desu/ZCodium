import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as yauzl from "yauzl";
import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";
import {
  classifyZipEntry,
  normalizeZipRelativePath,
  resolveZipPathWithin,
  validateZipDownloadUrl,
} from "./zip-source-paths.js";
import { PluginZipDownloadError } from "./zip-source-core.js";
import {
  ZIP_DOWNLOAD_MAX_BYTES,
  ZIP_DOWNLOAD_TIMEOUT_MS,
  ZIP_EXTRACT_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_REDIRECTS,
  ZIP_MAX_SINGLE_FILE_BYTES,
  throwIfAborted,
  type ZipExtractResult,
} from "./zip-source-core.js";

export async function downloadZipArchive(input: {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  url: string;
}): Promise<Uint8Array> {
  // agent 会封存用户 shell 代理，ZIP 下载必须和其他应用层 fetch 一样读取 captured proxy fallback。
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
    timeoutMs: ZIP_DOWNLOAD_TIMEOUT_MS,
  });
  let currentUrl = input.url;
  let currentHeaders = input.headers;
  for (let redirectCount = 0; redirectCount <= ZIP_MAX_REDIRECTS; redirectCount += 1) {
    throwIfAborted(input.signal);
    validateZipDownloadUrl(currentUrl);
    const response = await client.request(
      {
        headers: currentHeaders,
        maxResponseBytes: ZIP_DOWNLOAD_MAX_BYTES,
        method: "GET",
        redirect: "manual",
        url: currentUrl,
      },
      { signal: input.signal },
    );

    if (isRedirectStatus(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Plugin zip download redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 跨 CDN origin 继续发送 marketplace 自定义 header 会把内部元数据泄露给跳转目标。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new PluginZipDownloadError(
        `Failed to download plugin zip: ${response.status} ${response.statusText}`,
        currentUrl,
        response.status,
      );
    }
    return response.body;
  }
  throw new Error(`Plugin zip download exceeded redirect limit: ${input.url}`);
}

export async function extractZipArchive(input: {
  archivePath: string;
  signal?: AbortSignal;
  targetRoot: string;
}): Promise<ZipExtractResult> {
  const targetRoot = resolve(input.targetRoot);
  await mkdir(targetRoot, { recursive: true });
  const zipFile = await openZipFile(input.archivePath);
  const topLevelSegments = new Set<string>();
  let entryCount = 0;
  let extractedBytes = 0;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const rejectOnce = (error: unknown): void => {
        zipFile.close();
        rejectPromise(error);
      };
      zipFile.once("error", rejectOnce);
      zipFile.once("end", () => {
        zipFile.removeListener("error", rejectOnce);
        resolvePromise();
      });
      zipFile.on("entry", (entry) => {
        void (async () => {
          try {
            throwIfAborted(input.signal);
            entryCount += 1;
            if (entryCount > ZIP_MAX_ENTRIES) {
              throw new Error(`Plugin zip has too many entries: ${entryCount}/${ZIP_MAX_ENTRIES}`);
            }

            const normalizedPath = normalizeZipRelativePath(entry.fileName);
            topLevelSegments.add(normalizedPath.split("/")[0] ?? normalizedPath);
            const targetPath = resolveZipPathWithin(targetRoot, normalizedPath);
            const kind = classifyZipEntry(entry);
            if (kind === "directory") {
              await mkdir(targetPath, { recursive: true });
              zipFile.readEntry();
              return;
            }

            if (entry.uncompressedSize > ZIP_MAX_SINGLE_FILE_BYTES) {
              throw new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`);
            }
            const bytes = await readZipEntryBuffer(zipFile, entry, input.signal);
            extractedBytes += bytes.byteLength;
            if (extractedBytes > ZIP_EXTRACT_MAX_BYTES) {
              throw new Error(
                `Plugin zip extracted content exceeds limit: ${extractedBytes}/${ZIP_EXTRACT_MAX_BYTES}`,
              );
            }
            await mkdir(dirname(targetPath), { recursive: true });
            await writeFile(targetPath, bytes);
            zipFile.readEntry();
          } catch (error) {
            rejectOnce(error);
          }
        })();
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }

  return { topLevelSegments };
}

function openZipFile(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!zipFile) {
        rejectPromise(new Error("Failed to open plugin zip archive"));
        return;
      }
      resolvePromise(zipFile);
    });
  });
}

function readZipEntryBuffer(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!stream) {
        rejectPromise(new Error(`Failed to read plugin zip entry: ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      let bytesRead = 0;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        stream.destroy(new Error("Plugin operation cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.byteLength;
        if (bytesRead > ZIP_MAX_SINGLE_FILE_BYTES) {
          stream.destroy(
            new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`),
          );
          return;
        }
        chunks.push(buffer);
      });
      stream.once("error", (streamError) => {
        cleanup();
        rejectPromise(streamError);
      });
      stream.once("end", () => {
        cleanup();
        resolvePromise(Buffer.concat(chunks));
      });
    });
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
