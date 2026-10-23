import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  createFileSystemError,
  type FileSystemSearchTextEntry,
  type FileSystemSearchTextRequest,
} from "@zcode/contracts";
import { createGlobMatcher, walkFiles, toPosixRelative } from "./file-walk.js";
import { matchesFileType } from "./file-types.js";

interface FileSearchCandidate {
  path: string;
  mtimeMs: number;
}

interface TextSearchResult {
  matchCount: number;
  entries: FileSystemSearchTextEntry[];
}

interface LineRange {
  start: number;
  end: number;
}

interface OnlyMatchingMatches {
  matchCount: number;
  ranges: LineRange[];
  entriesByLine: Map<number, FileSystemSearchTextEntry[]>;
}

export function compileSearchRegex(pattern: string, request: FileSystemSearchTextRequest): RegExp {
  try {
    const flags = `${request.ignoreCase ? "i" : ""}${request.multiline ? "s" : ""}`;
    return new RegExp(pattern, flags);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path: request.path,
      message: `Invalid grep regular expression: ${pattern}`,
      cause: error,
    });
  }
}

export async function collectTextSearchCandidates(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSearchCandidate[]> {
  const candidates: FileSearchCandidate[] = [];
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;
  const root = rootInfo.isDirectory() ? path : dirname(path);

  const addIfCandidate = async (filePath: string, info: Awaited<ReturnType<typeof stat>>) => {
    if (!info.isFile()) return;
    const relativePath = toPosixRelative(root, filePath);
    if (globMatcher && !globMatcher(relativePath, basename(filePath))) return;
    if (request.type && !matchesFileType(filePath, request.type)) return;
    candidates.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
  };

  if (rootInfo.isFile()) {
    await addIfCandidate(path, rootInfo);
    return candidates;
  }

  if (!rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  await walkFiles(root, signal, addIfCandidate);
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return candidates;
}

export function searchLineContent(
  path: string,
  content: string,
  regex: RegExp,
  request: FileSystemSearchTextRequest,
): TextSearchResult {
  const lines = splitRipgrepSearchLines(content);

  if (request.onlyMatching) {
    return createOnlyMatchingSearchResult({
      path,
      lines,
      request,
      matches: collectLineOnlyMatchingMatches(path, lines, regex),
    });
  }

  const matchingIndexes: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    regex.lastIndex = 0;
    if (regex.test(lines[index] ?? "")) {
      matchingIndexes.push(index);
    }
  }

  const ranges = matchingIndexes.map((index) => ({ start: index, end: index }));
  const matchedLineIndexes = new Set(matchingIndexes);
  const entries = createContextLineIndexes(lines.length, ranges, request).map((lineIndex) => ({
    path,
    lineNumber: lineIndex + 1,
    text: lines[lineIndex] ?? "",
    matched: matchedLineIndexes.has(lineIndex),
  }));

  return {
    matchCount: matchingIndexes.length,
    entries,
  };
}

export function searchMultilineContent(
  path: string,
  content: string,
  regex: RegExp,
  request: FileSystemSearchTextRequest,
): TextSearchResult {
  const lines = splitRipgrepSearchLines(content);
  if (request.onlyMatching) {
    return createOnlyMatchingSearchResult({
      path,
      lines,
      request,
      matches: collectMultilineOnlyMatchingMatches(path, content, regex),
    });
  }

  const flags = `${regex.ignoreCase ? "i" : ""}gs`;
  const globalRegex = new RegExp(regex.source, flags);
  const entries: FileSystemSearchTextEntry[] = [];
  let matchCount = 0;

  for (const match of content.matchAll(globalRegex)) {
    const index = match.index ?? 0;
    const lineNumber = lineNumberForIndex(content, index);
    const text = firstLine(match[0]);
    entries.push({
      path,
      lineNumber,
      text,
      matched: true,
    });
    matchCount += 1;
  }

  return { matchCount, entries };
}

function collectLineOnlyMatchingMatches(
  path: string,
  lines: string[],
  regex: RegExp,
): OnlyMatchingMatches {
  const entriesByLine = new Map<number, FileSystemSearchTextEntry[]>();
  const globalRegex = new RegExp(regex.source, `${regex.ignoreCase ? "i" : ""}g`);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const entries: FileSystemSearchTextEntry[] = [];
    globalRegex.lastIndex = 0;
    for (const match of line.matchAll(globalRegex)) {
      entries.push(
        ...createOnlyMatchingEntries({
          path,
          lineNumber: lineIndex + 1,
          text: match[0],
        }),
      );
    }
    if (entries.length > 0) {
      entriesByLine.set(lineIndex, entries);
    }
  }

  return {
    matchCount: entriesByLine.size,
    ranges: Array.from(entriesByLine.keys()).map((lineIndex) => ({
      start: lineIndex,
      end: lineIndex,
    })),
    entriesByLine,
  };
}

function collectMultilineOnlyMatchingMatches(
  path: string,
  content: string,
  regex: RegExp,
): OnlyMatchingMatches {
  const matches: OnlyMatchingMatches = {
    matchCount: 0,
    ranges: [],
    entriesByLine: new Map(),
  };
  const globalRegex = new RegExp(regex.source, `${regex.ignoreCase ? "i" : ""}gs`);

  for (const match of content.matchAll(globalRegex)) {
    const matchIndex = match.index ?? 0;
    const startLineNumber = lineNumberForIndex(content, matchIndex);
    const entries = createOnlyMatchingEntries({
      path,
      lineNumber: startLineNumber,
      text: match[0],
    });
    for (const entry of entries) {
      const lineIndex = (entry.lineNumber ?? startLineNumber) - 1;
      const existing = matches.entriesByLine.get(lineIndex) ?? [];
      existing.push(entry);
      matches.entriesByLine.set(lineIndex, existing);
    }

    const endIndex = Math.max(matchIndex, matchIndex + match[0].length - 1);
    matches.ranges.push({
      start: startLineNumber - 1,
      end: lineNumberForIndex(content, endIndex) - 1,
    });
    matches.matchCount += 1;
  }

  return matches;
}

function createOnlyMatchingSearchResult(input: {
  path: string;
  lines: string[];
  request: FileSystemSearchTextRequest;
  matches: OnlyMatchingMatches;
}): TextSearchResult {
  return {
    matchCount: input.matches.matchCount,
    entries: createOnlyMatchingContentEntries(input),
  };
}

function createOnlyMatchingContentEntries(input: {
  path: string;
  lines: string[];
  request: FileSystemSearchTextRequest;
  matches: OnlyMatchingMatches;
}): FileSystemSearchTextEntry[] {
  const matchedLineIndexes = createMatchedLineIndexes(input.matches.ranges);

  return createContextLineIndexes(input.lines.length, input.matches.ranges, input.request).flatMap(
    (lineIndex) => {
      const matchedEntries = input.matches.entriesByLine.get(lineIndex);
      if (matchedEntries) return matchedEntries;
      if (matchedLineIndexes.has(lineIndex)) return [];
      return [
        {
          path: input.path,
          lineNumber: lineIndex + 1,
          text: input.lines[lineIndex] ?? "",
          matched: false,
        },
      ];
    },
  );
}

function createContextLineIndexes(
  lineCount: number,
  ranges: LineRange[],
  request: FileSystemSearchTextRequest,
): number[] {
  const context = request.context ?? 0;
  const beforeContext = request.beforeContext ?? context;
  const afterContext = request.afterContext ?? context;
  const indexes = new Set<number>();

  for (const range of ranges) {
    const start = Math.max(0, range.start - beforeContext);
    const end = Math.min(lineCount - 1, range.end + afterContext);
    for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
      indexes.add(lineIndex);
    }
  }

  return Array.from(indexes).sort((left, right) => left - right);
}

function createMatchedLineIndexes(ranges: LineRange[]): Set<number> {
  const indexes = new Set<number>();
  for (const range of ranges) {
    for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
      indexes.add(lineIndex);
    }
  }
  return indexes;
}

export function createOnlyMatchingEntries(input: {
  path: string;
  lineNumber?: number;
  text: string;
}): FileSystemSearchTextEntry[] {
  if (input.text.length === 0) {
    return [
      {
        path: input.path,
        lineNumber: input.lineNumber,
        text: "",
        matched: true,
      },
    ];
  }

  // ripgrep 只把 LF/CRLF 当作输出行边界；单独的 CR 是普通匹配文本。
  // 同时，跨行 match 内部的空行不生成 entry，但整段零长度 match 需要保留空 entry。
  return input.text.split(/\r?\n/).flatMap((line, index) =>
    line.length === 0
      ? []
      : [
          {
            path: input.path,
            lineNumber: input.lineNumber === undefined ? undefined : input.lineNumber + index,
            text: line,
            matched: true,
          },
        ],
  );
}

function splitRipgrepSearchLines(content: string): string[] {
  // ripgrep 以 LF/CRLF 作为行结束符；末尾换行不是额外空行，单独的 CR 保留在行内容中。
  if (content.length === 0) return [];
  return content.replace(/\r?\n$/, "").split(/\r?\n/);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function lineNumberForIndex(content: string, index: number): number {
  let lineNumber = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) {
      lineNumber += 1;
    }
  }
  return lineNumber;
}

export async function readCandidateContent(candidate: FileSearchCandidate): Promise<string> {
  return await readFile(candidate.path, "utf8");
}
