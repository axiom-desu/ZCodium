import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import {
  createFileSystemError,
  type FileSystemNodeKind,
  type FileSystemRevision,
} from "@zcode/contracts";

export function getNodeErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

export function nodeKind(info: Awaited<ReturnType<typeof stat>>): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

export function direntKind(info: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

export function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}

export function resolveAbsoluteRequestPath(path: string): string {
  if (!isAbsolute(path)) {
    throw createFileSystemError({
      code: "invalid_path",
      path,
      message: `FileSystemPort requires an absolute path: ${path}`,
    });
  }
  return normalize(path);
}

export function hashBuffer(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatByteUnit(bytes / 1024)}KB`;
  return `${formatByteUnit(bytes / (1024 * 1024))}MB`;
}

function formatByteUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

export function toFileSystemError(error: unknown, path: string): Error {
  if (error instanceof Error && error.name === "FileSystemPortError") {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    // Preserve cancellation as its own code so tools do not report user aborts as I/O failures.
    return createFileSystemError({
      code: "cancelled",
      path,
      message: `File system operation was cancelled: ${path}`,
      cause: error,
    });
  }

  const code = getNodeErrorCode(error);
  if (code === "ENOENT") {
    return createFileSystemError({
      code: "not_found",
      path,
      message: `File not found: ${path}`,
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message: `Permission denied for path: ${path}`,
      cause: error,
    });
  }
  if (code === "EISDIR") {
    return createFileSystemError({
      code: "is_directory",
      path,
      message: `Path is a directory: ${path}`,
      cause: error,
    });
  }
  if (code === "ENAMETOOLONG") {
    return createFileSystemError({
      code: "invalid_path",
      path,
      message: `Invalid path: ${path}`,
      cause: error,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message: error instanceof Error ? error.message : `File system error for path: ${path}`,
    cause: error,
  });
}

export async function assertExpectedRevision(
  path: string,
  expected: FileSystemRevision,
): Promise<void> {
  const info = await stat(path);
  const actual = revisionId(info.mtimeMs, info.size);
  if (actual !== expected.id) {
    throw createFileSystemError({
      code: "stale_write",
      path,
      message: `File changed since it was read: ${path}`,
    });
  }
}

export function assertRegularFile(
  info: Awaited<ReturnType<typeof stat>>,
  path: string,
  descriptions: { directory: string; path: string },
): void {
  if (info.isDirectory()) {
    throw createFileSystemError({
      code: "is_directory",
      path,
      message: `Cannot read directory as ${descriptions.directory}: ${path}`,
    });
  }
  if (!info.isFile()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Cannot read non-file path as ${descriptions.path}: ${path}`,
    });
  }
}

export function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError("File system operation was cancelled");
}
