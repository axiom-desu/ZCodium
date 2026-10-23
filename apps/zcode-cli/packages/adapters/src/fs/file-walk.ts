import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createFileSystemError } from "@zcode/contracts";
import { throwIfAborted } from "./path-errors.js";

export const DEFAULT_GLOB_MAX_RESULTS = 100;
const DEFAULT_GREP_HEAD_LIMIT = 250;
export const VCS_DIRECTORIES_TO_EXCLUDE = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

export async function walkFiles(
  current: string,
  signal: AbortSignal | undefined,
  visitor: (path: string, info: Awaited<ReturnType<typeof stat>>) => Promise<void> | void,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    throwIfAborted(signal);
    const childPath = join(current, entry.name);

    if (entry.isDirectory()) {
      if (VCS_DIRECTORIES_TO_EXCLUDE.has(entry.name)) continue;
      await walkFiles(childPath, signal, visitor);
      continue;
    }

    if (!entry.isFile()) continue;

    const info = await stat(childPath);
    await visitor(childPath, info);
  }
}

export function createGlobMatcher(
  pattern: string,
): (relativePath: string, fileName: string) => boolean {
  const normalized = normalizeGlobPattern(pattern);
  const regex = globPatternToRegExp(normalized);
  const basenameRegex = normalized.includes("/") ? undefined : globPatternToRegExp(normalized);

  return (relativePath, fileName) =>
    regex.test(relativePath) || (basenameRegex ? basenameRegex.test(fileName) : false);
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterNext = pattern[index + 2];
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        regex += `(?:${alternatives})`;
        index = end;
        continue;
      }
    }

    regex += escapeRegExp(char ?? "");
  }

  regex += "$";
  try {
    return new RegExp(regex);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      message: `Invalid glob pattern: ${pattern}`,
      cause: error,
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function toPosixRelative(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

export function applyHeadLimit<T>(
  items: T[],
  headLimit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit?: number; appliedOffset?: number; truncated: boolean } {
  if (headLimit === 0) {
    return {
      items: items.slice(offset),
      appliedOffset: offset > 0 ? offset : undefined,
      truncated: false,
    };
  }

  const effectiveLimit = headLimit ?? DEFAULT_GREP_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const truncated = items.length - offset > effectiveLimit;

  return {
    items: sliced,
    appliedLimit: truncated ? effectiveLimit : undefined,
    appliedOffset: offset > 0 ? offset : undefined,
    truncated,
  };
}

export function looksBinary(content: string): boolean {
  return content.includes("\0");
}
