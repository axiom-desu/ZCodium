// ============================================================
// Node FileSystem Adapter
// ============================================================

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import {
  createFileSystemError,
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemCreateDirectoryRequest,
  type FileSystemCreateDirectoryResult,
  type FileSystemReadBytesRequest,
  type FileSystemReadBytesResult,
  type FileSystemReadTextRequest,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextResult,
  type FileSystemListDirectoryRequest,
  type FileSystemListDirectoryResult,
  type FileSystemRemoveFileRequest,
  type FileSystemRemoveFileResult,
  type FileSystemSearchFilesRequest,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
  type FileSystemStatRequest,
  type FileSystemStatResult,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
} from "@zcode/contracts";
import {
  applyRequestedLineEndings,
  decodeTextBuffer,
  detectLineEndings,
  encodeTextContent,
  normalizeLineEndings,
  shouldNormalizeLineEndings,
} from "./text-metadata.js";
import { readTextFileRangeFromNode } from "./text-range-reader.js";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";
import { atomicWrite } from "./atomic-write.js";
import { readAtMostBytes, readFirstBytes } from "./read-bytes.js";
import {
  DEFAULT_GLOB_MAX_RESULTS,
  createGlobMatcher,
  toPosixRelative,
  walkFiles,
} from "./file-walk.js";
import {
  assertExpectedRevision,
  assertRegularFile,
  direntKind,
  formatByteCount,
  hashBuffer,
  nodeKind,
  resolveAbsoluteRequestPath,
  revisionId,
  throwIfAborted,
  toFileSystemError,
} from "./path-errors.js";
import {
  RipgrepRuntimeFailure,
  setRipgrepTimeoutMs,
  setRipgrepWorkerFactory,
  type RipgrepWorkerFactory,
} from "./ripgrep-worker.js";
import { searchTextWithJavaScript, searchTextWithRipgrep } from "./text-search-runner.js";

export interface NodeFileSystemAdapterOptions {
  textSearchEngine?: "ripgrep" | "javascript";
}

export class NodeFileSystemAdapter implements FileSystemPort {
  constructor(private readonly adapterOptions: NodeFileSystemAdapterOptions = {}) {}

  async createDirectory(
    request: FileSystemCreateDirectoryRequest,
  ): Promise<FileSystemCreateDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      maybeThrowStorageFsFault({ operation: "mkdir", path });
      await mkdir(path, { recursive: true });
      return { path };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async stat(request: FileSystemStatRequest): Promise<FileSystemStatResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    try {
      const info = await stat(path);
      const kind = nodeKind(info);
      return {
        path,
        kind,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
        revision:
          kind === "file"
            ? {
                id: revisionId(info.mtimeMs, info.size),
                mtimeMs: info.mtimeMs,
                sizeBytes: info.size,
              }
            : undefined,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async readTextFile(request: FileSystemReadTextRequest): Promise<FileSystemReadTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      assertRegularFile(info, path, { directory: "text file", path: "text" });

      const maxBytes = request.maxBytes;
      const truncated = maxBytes !== undefined && info.size > maxBytes;
      const buffer = truncated ? await readFirstBytes(path, maxBytes) : await readFile(path);
      const decoded = decodeTextBuffer({ buffer, encoding: request.encoding, path });
      const rawContent = decoded.content;
      const encoding = decoded.encoding;
      const isText = shouldNormalizeLineEndings(encoding);
      const lineEndings = isText ? detectLineEndings(rawContent) : undefined;
      const content = isText ? normalizeLineEndings(rawContent) : rawContent;

      return {
        path,
        content,
        encoding,
        lineEndings,
        bytesRead: buffer.byteLength,
        sizeBytes: info.size,
        truncated,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(buffer),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async readBinaryFile(request: FileSystemReadBytesRequest): Promise<FileSystemReadBytesResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      assertRegularFile(info, path, { directory: "binary file", path: "binary" });
      if (request.maxBytes !== undefined && info.size > request.maxBytes) {
        throw createFileSystemError({
          code: "too_large",
          path,
          message: `File content (${formatByteCount(info.size)}) exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
        });
      }

      const buffer =
        request.maxBytes === undefined
          ? await readFile(path)
          : await readAtMostBytes(path, request.maxBytes + 1, info.size);
      if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
        // stat 与 readFile 之间文件可能增长；实际读取也必须保持有界，
        // 否则 maxBytes 既挡不住超限内容，也挡不住一次性大内存分配。
        throw createFileSystemError({
          code: "too_large",
          path,
          message: `File content exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
        });
      }
      return {
        path,
        content: buffer,
        bytesRead: buffer.byteLength,
        sizeBytes: info.size,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(buffer),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemReadTextRangeResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      const info = await stat(path);
      assertRegularFile(info, path, { directory: "text file", path: "text" });

      return await readTextFileRangeFromNode({ ...request, path }, info, options?.signal);
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async writeTextFile(request: FileSystemWriteTextRequest): Promise<FileSystemWriteTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const encoding = request.encoding ?? "utf8";
    const textContent = applyRequestedLineEndings(request.content, request.lineEndings);
    const content = encodeTextContent({ content: textContent, encoding, path });

    try {
      if (request.expectedRevision) {
        await assertExpectedRevision(path, request.expectedRevision);
      }

      if (request.createParents) {
        maybeThrowStorageFsFault({ operation: "mkdir", path: dirname(path) });
        await mkdir(dirname(path), { recursive: true });
      }

      if (request.atomic ?? true) {
        await atomicWrite(path, content);
      } else {
        maybeThrowStorageFsFault({ operation: "writeFile", path });
        await writeFile(path, content);
      }

      const info = await stat(path);
      return {
        path,
        bytesWritten: content.byteLength,
        revision: {
          id: revisionId(info.mtimeMs, info.size),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          hash: hashBuffer(content),
        },
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async removeFile(
    request: FileSystemRemoveFileRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemRemoveFileResult> {
    const path = resolveAbsoluteRequestPath(request.path);

    try {
      throwIfAborted(options?.signal);
      maybeThrowStorageFsFault({ operation: "rm", path });
      await unlink(path);
      return { path, removed: true };
    } catch (error) {
      const normalized = toFileSystemError(error, path);
      if (
        request.missingOk === true &&
        isFileSystemPortError(normalized) &&
        normalized.code === "not_found"
      ) {
        return { path, removed: false };
      }
      throw normalized;
    }
  }

  async listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemListDirectoryResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const startedAt = Date.now();

    try {
      throwIfAborted(options?.signal);
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Directory listing path must be a directory: ${path}`,
        });
      }

      const entries = await readdir(path, { withFileTypes: true });
      throwIfAborted(options?.signal);
      const mapped = entries
        .map((entry) => ({
          kind: direntKind(entry),
          name: entry.name,
          path: join(path, entry.name),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        path,
        durationMs: Math.max(0, Date.now() - startedAt),
        entries: mapped,
        numEntries: mapped.length,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchFilesResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const pattern = request.pattern.trim();
    const startedAt = Date.now();

    if (pattern.length === 0) {
      throw createFileSystemError({
        code: "invalid_pattern",
        path,
        message: "Glob pattern must not be empty",
      });
    }

    try {
      throwIfAborted(options?.signal);
      const rootInfo = await stat(path);
      if (!rootInfo.isDirectory()) {
        throw createFileSystemError({
          code: "not_file",
          path,
          message: `Glob search path must be a directory: ${path}`,
        });
      }

      const matcher = createGlobMatcher(pattern);
      const matches: Array<{ path: string; mtimeMs: number }> = [];

      await walkFiles(path, options?.signal, async (filePath, info) => {
        const relativePath = toPosixRelative(path, filePath);
        if (matcher(relativePath, basename(filePath))) {
          matches.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
        }
      });

      matches.sort((left, right) => {
        const timeComparison = right.mtimeMs - left.mtimeMs;
        return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
      });

      const offset = request.offset ?? 0;
      const maxResults = request.maxResults ?? DEFAULT_GLOB_MAX_RESULTS;
      const files = matches.slice(offset, offset + maxResults).map((match) => match.path);

      return {
        path,
        pattern,
        durationMs: Math.max(0, Date.now() - startedAt),
        files,
        numFiles: files.length,
        truncated: matches.length > offset + maxResults,
      };
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async searchText(
    request: FileSystemSearchTextRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchTextResult> {
    const path = resolveAbsoluteRequestPath(request.path);
    const normalizedRequest = request.path === path ? request : { ...request, path };

    if (this.adapterOptions.textSearchEngine === "javascript") {
      return searchTextWithJavaScript(normalizedRequest, options?.signal);
    }

    try {
      return await searchTextWithRipgrep(normalizedRequest, options?.signal);
    } catch (error) {
      if (error instanceof RipgrepRuntimeFailure) {
        return searchTextWithJavaScript(normalizedRequest, options?.signal);
      }
      throw toFileSystemError(error, path);
    }
  }
}

export function createNodeFileSystemAdapter(
  options: NodeFileSystemAdapterOptions = {},
): NodeFileSystemAdapter {
  return new NodeFileSystemAdapter(options);
}

export function setRipgrepWorkerFactoryForTests(
  factory: RipgrepWorkerFactory | undefined,
): () => void {
  return setRipgrepWorkerFactory(factory);
}

export function setRipgrepTimeoutMsForTests(timeoutMs: number | undefined): () => void {
  return setRipgrepTimeoutMs(timeoutMs);
}
