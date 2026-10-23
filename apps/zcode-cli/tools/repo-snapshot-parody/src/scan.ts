/**
 * 工作区扫描与清单。
 *
 * 收录规则逐条复刻闭源版 `scanRepoSnapshot`，包括它最越界的那条：
 * `.git` 被**强制收录**，且跳过体积上限与二进制判定。原样保留是为了让演示诚实——
 * 这个工具不是来证明"ZCode 其实没传那么多"的。
 */

import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { PARODY_SCHEMA, type ManifestFile, type RepoSnapshotManifest } from "./types.js";

const NODE_MODULES = new Set(["node_modules"]);
const CACHE_DIRS = new Set([".cache", ".turbo"]);
const BUILD_OUTPUT_DIRS = new Set(["dist", "build", "out", ".next", "coverage"]);
const GIT_INTERNAL = new Set([".git"]);
const SECRET_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;

export type SkipReason =
  | "unsupported"
  | "dependency"
  | "cache"
  | "build-output"
  | "secret"
  | "large-file"
  | "binary";

export interface ScanDecision {
  readonly include: boolean;
  readonly reason?: SkipReason | "git-internal";
}

function pathSegments(relativePath: string): string[] {
  return relativePath.split("/").filter(Boolean);
}

function isTopLevelBuildOutputPath(segments: string[]): boolean {
  const first = segments[0]?.toLowerCase();
  if (!first) return false;
  return BUILD_OUTPUT_DIRS.has(first) || first.startsWith("dist-") || first.endsWith("-unpacked");
}

function hasElectronUnpackedSegment(segments: string[]): boolean {
  return segments.some((segment) => segment.toLowerCase() === "app.asar.unpacked");
}

function looksLikeSecretPath(relativePath: string): boolean {
  const segments = pathSegments(relativePath);
  const basename = (segments.at(-1) ?? relativePath).toLowerCase();
  return (
    SECRET_FILE_NAMES.has(basename) ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx") ||
    basename.includes("token") ||
    basename.includes("secret")
  );
}

function looksLikeElectronAsarPath(relativePath: string): boolean {
  const segments = pathSegments(relativePath.toLowerCase());
  return (segments.at(-1) ?? "").endsWith(".asar") || segments.includes("app.asar.unpacked");
}

/** `.git` 本体或 `.git/config` 这类根元数据文件。 */
function isRootGitMetadataFile(relativePath: string): boolean {
  return relativePath === ".git";
}

function hasGitInternalSegment(segments: string[]): boolean {
  return segments.some((segment) => GIT_INTERNAL.has(segment));
}

/** 采样前判定。注意 `.git` 分支排在所有排除规则（含 large-file）之前。 */
export function decideBeforeSample(input: {
  relativePath: string;
  sizeBytes: number;
  isSymbolicLink: boolean;
}): ScanDecision {
  const segments = pathSegments(input.relativePath);

  if (input.isSymbolicLink) return { include: false, reason: "unsupported" };
  // 复刻点：.git 强制收录，不看大小、不看是不是二进制
  if (isRootGitMetadataFile(input.relativePath) || hasGitInternalSegment(segments)) {
    return { include: true, reason: "git-internal" };
  }
  if (segments.some((segment) => NODE_MODULES.has(segment))) {
    return { include: false, reason: "dependency" };
  }
  if (segments.some((segment) => CACHE_DIRS.has(segment))) {
    return { include: false, reason: "cache" };
  }
  if (
    hasElectronUnpackedSegment(segments) ||
    looksLikeElectronAsarPath(input.relativePath) ||
    isTopLevelBuildOutputPath(segments)
  ) {
    return { include: false, reason: "build-output" };
  }
  if (looksLikeSecretPath(input.relativePath)) return { include: false, reason: "secret" };
  if (input.sizeBytes > MAX_FILE_BYTES) return { include: false, reason: "large-file" };
  return { include: true };
}

/** 采样后判定。`.git` 再次跳过二进制检测。 */
export function decideAfterSample(input: { relativePath: string; sample: Buffer }): ScanDecision {
  const before = decideBeforeSample({
    relativePath: input.relativePath,
    sizeBytes: 0,
    isSymbolicLink: false,
  });
  if (!before.include) return before;
  if (
    isRootGitMetadataFile(input.relativePath) ||
    hasGitInternalSegment(pathSegments(input.relativePath))
  ) {
    return { include: true, reason: "git-internal" };
  }
  if (input.sample.includes(0)) return { include: false, reason: "binary" };
  return { include: true };
}

/** 工作区稳定标识：规范化绝对路径。目录名用它的哈希，不在路径上泄位置。 */
export function workspaceKeyOf(workspacePath: string): string {
  return resolve(workspacePath);
}

export function workspaceKeyHash(workspaceKey: string): string {
  return createHash("sha256").update(workspaceKey).digest("hex").slice(0, 12);
}

async function looksBinary(absolutePath: string): Promise<boolean> {
  const blob = await openAsBlob(absolutePath);
  const head = (await blob.slice(0, BINARY_SAMPLE_BYTES).arrayBuffer()) as ArrayBuffer;
  return Buffer.from(head).includes(0);
}

async function listGitFiles(workspacePath: string): Promise<string[] | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: workspacePath,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolvePromise(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      resolvePromise(raw.split("\0").filter((entry) => entry.length > 0));
    });
  });
}

/** 非 git 仓库的退路：按同一套排除规则遍历。 */
async function walkWorkspace(workspacePath: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (absoluteDir: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = relative(workspacePath, join(absoluteDir, entry.name));
      const segments = pathSegments(relativePath);
      if (segments.some((segment) => NODE_MODULES.has(segment) || CACHE_DIRS.has(segment)))
        continue;
      if (entry.isDirectory()) {
        if (isTopLevelBuildOutputPath(segments) || hasElectronUnpackedSegment(segments)) continue;
        await visit(join(absoluteDir, entry.name), depth + 1);
        continue;
      }
      found.push(relativePath);
    }
  };
  await visit(workspacePath, 0);
  return found;
}

export interface ScanResult {
  readonly manifest: RepoSnapshotManifest;
  /** 供打包使用的绝对路径映射。 */
  readonly absolutePaths: ReadonlyMap<string, string>;
}

export async function scanRepoSnapshot(
  workspacePath: string,
  options: { now?: () => number } = {},
): Promise<ScanResult> {
  const root = resolve(workspacePath);
  const gitFiles = await listGitFiles(root);
  const source: "git" | "walk" = gitFiles === null ? "walk" : "git";
  const candidates = gitFiles ?? (await walkWorkspace(root));

  const files: ManifestFile[] = [];
  const absolutePaths = new Map<string, string>();

  for (const relativePath of candidates) {
    const normalized = relativePath.split(sep).join("/");
    if (!normalized || isAbsolute(normalized) || normalized.startsWith("..")) continue;

    const absolutePath = join(root, normalized);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      continue; // 扫描中消失的文件：跳过，不计失败
    }
    const isSymbolicLink = stats.isSymbolicLink();

    const before = decideBeforeSample({
      relativePath: normalized,
      sizeBytes: stats.size,
      isSymbolicLink,
    });
    if (!before.include) continue;

    if (!isSymbolicLink && !stats.isFile()) continue;

    if (!isRootGitMetadataFile(normalized) && !hasGitInternalSegment(pathSegments(normalized))) {
      if (await looksBinary(absolutePath)) continue;
    }

    files.push({ path: normalized, sizeBytes: stats.size });
    absolutePaths.set(normalized, absolutePath);
  }

  files.sort((left, right) => left.path.localeCompare(right.path));

  const manifest: RepoSnapshotManifest = {
    schema: PARODY_SCHEMA,
    workspaceKey: workspaceKeyOf(root),
    createdAt: options.now ? options.now() : Date.now(),
    source,
    files,
    stats: {
      includedFileCount: files.length,
      includedBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    },
  };

  return { manifest, absolutePaths };
}
