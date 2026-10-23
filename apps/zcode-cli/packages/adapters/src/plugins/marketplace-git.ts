import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  isRecord,
  resolveInside,
} from "./helpers.js";
import {
  resolveGitHubArchiveSource,
  shouldFallbackGitHubArchiveToGit,
} from "./github-archive-source.js";
import {
  createArchiveFetchError,
  createGitUnavailableError,
  isCommandUnavailableError,
} from "./source-errors.js";
import {
  GIT_CLONE_MAX_ATTEMPTS,
  GIT_CLONE_RETRY_DELAY_MS,
  GIT_COMMAND_TIMEOUT_MS,
  buildMarketplaceGitEnv,
  delay,
  throwIfPluginOperationAborted,
  type ResolvedPluginSourceRoot,
} from "./marketplace-types.js";

const execFileAsync = promisify(execFile);

async function resolveGitPluginSource(input: {
  path?: string;
  ref?: string;
  signal?: AbortSignal;
  sha?: string;
  url: string;
}): Promise<ResolvedPluginSourceRoot> {
  const dir = await clonePluginSource(input.url, input.ref, input.sha, input.signal);
  const cleanup = async (): Promise<void> => {
    await rm(dir, { force: true, recursive: true });
  };
  if (!input.path) return { cleanup, path: dir };
  throwIfPluginOperationAborted(input.signal);
  const subdir = resolveInside(dir, input.path);
  if (!subdir || !directoryExists(subdir)) {
    const primaryError = new Error(`Plugin source subdirectory does not exist: ${input.path}`);
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
    throw appendPluginSourceCleanupError(primaryError, cleanupError);
  }
  return { cleanup, path: subdir };
}

export async function resolveRepositoryPluginSource(input: {
  path?: string;
  ref?: string;
  signal?: AbortSignal;
  sha?: string;
  url: string;
}): Promise<ResolvedPluginSourceRoot> {
  try {
    return await resolveGitHubArchiveSource({
      path: input.path,
      pin: input.sha ?? input.ref,
      signal: input.signal,
      url: input.url,
    });
  } catch (error) {
    if (!shouldFallbackGitHubArchiveToGit(error)) {
      throw createArchiveFetchError(input.url, error);
    }
  }
  return resolveGitPluginSource(input);
}

async function clonePluginSource(
  url: string,
  ref: string | undefined,
  sha?: string,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-src-"));
  const args = ["clone"];
  if (!sha) args.push("--depth", "1");
  if (ref) args.push("--branch", ref);
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sha) await execGitCommand(["-C", dir, "checkout", sha], signal);
    return dir;
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

export async function resolveRepositoryMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<ResolvedPluginSourceRoot> {
  // sparsePaths 是既有 MarketplaceSource 契约。Archive 需要先下载整仓，
  // 会让原本能 sparse clone 的大仓库因下载上限失败；在 Archive 尚未实现等价投影前，
  // 显式保留系统 Git 的 sparse checkout 路由。
  if (!sparsePaths?.length) {
    try {
      return await resolveGitHubArchiveSource({ pin: ref, signal, url });
    } catch (error) {
      if (!shouldFallbackGitHubArchiveToGit(error)) {
        throw createArchiveFetchError(url, error);
      }
    }
  }
  const dir = await cloneMarketplaceSource(url, ref, sparsePaths, signal);
  return {
    cleanup: async () => {
      await rm(dir, { force: true, recursive: true });
    },
    path: dir,
  };
}

async function cloneMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-marketplace-src-"));
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  if (sparsePaths?.length) args.push("--filter=blob:none", "--sparse");
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sparsePaths?.length) {
      await execGitCommand(["-C", dir, "sparse-checkout", "set", ...sparsePaths], signal);
    }
    return dir;
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
}

async function execGitCloneWithRetry(
  args: string[],
  targetDir: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GIT_CLONE_MAX_ATTEMPTS; attempt += 1) {
    try {
      throwIfPluginOperationAborted(signal);
      if (attempt > 1) {
        await rm(targetDir, { force: true, recursive: true });
        await mkdir(targetDir, { recursive: true });
      }
      await execGitCommand(args, signal);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= GIT_CLONE_MAX_ATTEMPTS || !isRetryableGitCloneError(error)) {
        throw error;
      }
      // GitHub 偶发 RPC/recv timeout 会让官方 marketplace add 失败。
      // 仅对明确的网络型 clone 错误做短重试，避免掩盖权限、路径或仓库不存在等确定性错误。
      await delay(GIT_CLONE_RETRY_DELAY_MS * attempt, signal);
    }
  }
  throw lastError;
}

async function execGitCommand(args: string[], signal?: AbortSignal): Promise<void> {
  throwIfPluginOperationAborted(signal);
  try {
    // 显式二进制覆盖既支持非标准 Git 安装位置，也让跨进程 E2E 能把 Git 指向不存在的
    // 绝对路径，真实证明 Archive 主链路不依赖开发机上偶然存在的 Git。
    const gitBinary = process.env.ZCODE_GIT_BINARY?.trim() || "git";
    await execFileAsync(gitBinary, args, {
      env: buildMarketplaceGitEnv(),
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 10,
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (isCommandUnavailableError(error)) {
      const source = args.find(
        (arg) => arg.includes("://") || arg.startsWith("git@") || arg.startsWith("git+"),
      );
      throw createGitUnavailableError(source ?? args.at(-1) ?? "Git operation");
    }
    throw error;
  }
  throwIfPluginOperationAborted(signal);
}

function isRetryableGitCloneError(error: unknown): boolean {
  const output = getErrorOutput(error);
  return /RPC failed|Operation timed out|Recv failure|expected flush|early EOF|remote end hung up|HTTP\/2 stream|Connection reset|ETIMEDOUT|ECONNRESET|network timeout/iu.test(
    output,
  );
}

function getErrorOutput(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const chunks = [
    error instanceof Error ? error.message : "",
    typeof error.stdout === "string" ? error.stdout : "",
    typeof error.stderr === "string" ? error.stderr : "",
  ];
  return chunks.filter(Boolean).join("\n");
}
