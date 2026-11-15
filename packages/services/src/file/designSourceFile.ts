import { constants } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DesignSourceWriteReason } from "./file.js";
import {
  normalizeApprovedDesignSourceRoots,
  type DesignSourceAuthority,
} from "./designSourceAuthority.js";

// 内置浏览器设计工具写回源码的 Host 侧边界（.agents/specs/upstream-3.18-browser-design-inspect.md）。
// 页面内容不可信：路径只能由宿主根据项目 root + 页面 URL 得出。这里在 realpath 之后仍然只用
// O_NOFOLLOW + fstat 得到的 fd 读写，并在写入前后复验「路径 → inode → root」三者，避免预览路径
// 在检查之后被换成项目外软链接/祖先目录交换后落盘；硬链接（nlink > 1）可能别名到 root 之外，直接拒绝。
// B7：rootPath 本身也必须由 Host 批准根 resolver 授权（每次读写重新读取），否则 renderer 传
// rootPath="/" 就能读写任意 html。没有 authority 的装配一律 fail closed，不影响其它文件方法。
// 唯一真值仍是内容 CAS：跨进程不合作写入者只能靠内容比较发现，不是跨进程强 CAS。

const DESIGN_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

// Windows 上这些 flag 可能不存在，退化为 0 时由后面的 dev/ino 复验兜底。
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW;
const WRITE_FLAGS = constants.O_RDWR | NO_FOLLOW;

class DesignSourceFileError extends Error {
  readonly reason: DesignSourceWriteReason;

  constructor(reason: DesignSourceWriteReason) {
    super(`design_source_${reason}`);
    this.name = "DesignSourceFileError";
    this.reason = reason;
  }
}

interface DesignSourceFileParams {
  rootPath: string;
  path: string;
}

interface WriteDesignSourceFileParams extends DesignSourceFileParams {
  expectedContent: string;
  content: string;
}

interface WriteDesignSourceFileResult {
  written: boolean;
  reason?: DesignSourceWriteReason;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface OpenedDesignSource {
  handle: FileHandle;
  targetPath: string;
  identity: FileIdentity;
  rootPath: string;
  rootIdentity: FileIdentity;
  size: number;
}

const HTML_EXTENSION_RE = /\.html?$/iu;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
// 同一 inode 的「读、比较、写」串行：两个 tab 同时提交同一版本时只有一个能通过 CAS。
// 表只归这个服务实例；用 dev:ino 而不是路径做 key，避免同一文件的多个路径绕过锁。
const writeLocks = new Map<string, Promise<unknown>>();

function hasUtf8Bom(buffer: Buffer): boolean {
  return UTF8_BOM.every((byte, index) => buffer[index] === byte);
}

function decodeStrictUtf8(buffer: Buffer): string {
  const body = hasUtf8Bom(buffer) ? buffer.subarray(UTF8_BOM.length) : buffer;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    // 保留 BOM：写回时仍然写同一份带 BOM 的 UTF-8，文件其余字节不变。
    return hasUtf8Bom(buffer) ? `\uFEFF${text}` : text;
  } catch {
    throw new DesignSourceFileError("invalid_utf8");
  }
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/** 路径/链接/类型问题是 invalid_path；真正的落盘 IO 失败必须显式返回 io_failed。 */
function reasonOf(error: unknown): DesignSourceWriteReason {
  if (error instanceof DesignSourceFileError) return error.reason;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
    case "EISDIR":
    case "ELOOP":
    case "ENAMETOOLONG":
    case "EXDEV":
      return "invalid_path";
    default:
      return "io_failed";
  }
}

async function readRootIdentity(rootPath: string): Promise<FileIdentity> {
  let rootStat: Awaited<ReturnType<typeof stat>>;
  try {
    // root 已经过 realpath；这里用 lstat 拒绝「root 自己被换成软链接」的交换，
    // 否则 realpath(root) 会把项目外目录当成新 root，后面的包含性检查会全部通过。
    rootStat = await lstat(rootPath);
  } catch {
    throw new DesignSourceFileError("invalid_path");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DesignSourceFileError("invalid_path");
  }
  return { dev: rootStat.dev, ino: rootStat.ino };
}

async function resolveProjectHtmlPath(
  params: DesignSourceFileParams,
  authority: DesignSourceAuthority | undefined,
): Promise<{
  rootPath: string;
  rootIdentity: FileIdentity;
  targetPath: string;
}> {
  if (!params.rootPath.trim() || !params.path.trim()) {
    throw new DesignSourceFileError("invalid_path");
  }
  if (!isAbsolute(params.rootPath) || !isAbsolute(params.path)) {
    throw new DesignSourceFileError("invalid_path");
  }
  // 先用本次调用重新读取的批准根授权 rootPath，再做 realpath/包含性检查。
  // 批准的是 Host 项目事实里的 root 字符串本身：指向它的软链接别名不是同一 root。
  const approvedRoot = await resolveApprovedDesignSourceRoot(params.rootPath, authority);
  let rootPath: string;
  let targetPath: string;
  try {
    rootPath = await realpath(approvedRoot);
    targetPath = await realpath(resolve(params.path));
  } catch {
    throw new DesignSourceFileError("invalid_path");
  }
  if (!isWithinRoot(rootPath, targetPath)) {
    throw new DesignSourceFileError("invalid_path");
  }
  if (!HTML_EXTENSION_RE.test(targetPath)) {
    throw new DesignSourceFileError("not_html");
  }
  return { rootPath, rootIdentity: await readRootIdentity(rootPath), targetPath };
}

/**
 * B7：服务端批准根授权。
 * - 没有 authority（旧构造/Web/server/远端装配）→ unauthorized_root，fail closed；
 * - 每次调用重新取批准根，无缓存，项目移除/改 root 后立即失效；
 * - rootPath 必须规范化后与某个批准根完全相等：软链接别名/self-mint 都不通过；
 * - authority 取事实失败（DB 未就绪/异常）也必须拒绝，不能当成空集以外的放行。
 */
async function resolveApprovedDesignSourceRoot(
  rootPath: string,
  authority: DesignSourceAuthority | undefined,
): Promise<string> {
  if (!authority) throw new DesignSourceFileError("unauthorized_root");
  let approved: ReadonlySet<string>;
  try {
    approved = normalizeApprovedDesignSourceRoots(await authority.resolveApprovedRoots());
  } catch {
    throw new DesignSourceFileError("unauthorized_root");
  }
  const requested = resolve(rootPath);
  if (!approved.has(requested)) throw new DesignSourceFileError("unauthorized_root");
  return requested;
}

/** 从 fd 精确读 size 字节：不用 readFile，避免 fd 内部 position 影响复读。 */
async function readHandleBytes(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  if (offset !== size) {
    // fstat 之后文件被并发截短：内容已不可信。
    throw new DesignSourceFileError("changed");
  }
  return buffer;
}

async function decodeHandleContent(handle: FileHandle, size: number): Promise<string> {
  if (size > DESIGN_SOURCE_MAX_BYTES) throw new DesignSourceFileError("too_large");
  const buffer = await readHandleBytes(handle, size);
  // 读的过程中文件被追加：仍然以 fstat 的完整长度为准，多出来的字节不静默截断。
  const after = await handle.stat();
  if (after.size !== size) throw new DesignSourceFileError("changed");
  return decodeStrictUtf8(buffer);
}

async function openDesignSource(
  params: DesignSourceFileParams,
  flags: number,
  authority: DesignSourceAuthority | undefined,
): Promise<OpenedDesignSource> {
  const resolved = await resolveProjectHtmlPath(params, authority);
  const handle = await open(resolved.targetPath, flags);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new DesignSourceFileError("invalid_path");
    // 硬链接可能在 root 之外另有名字：写入会同时改到项目外文件，失败关闭。
    if (fileStat.nlink > 1) throw new DesignSourceFileError("invalid_path");
    const identity: FileIdentity = { dev: fileStat.dev, ino: fileStat.ino };
    const opened: OpenedDesignSource = {
      handle,
      identity,
      rootIdentity: resolved.rootIdentity,
      rootPath: resolved.rootPath,
      size: fileStat.size,
      targetPath: resolved.targetPath,
    };
    if (!(await verifyDesignSourcePath(params, opened))) {
      throw new DesignSourceFileError("invalid_path");
    }
    return opened;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * 复验：请求路径仍然解析到同一个已打开 inode，且仍在同一个 root 内。
 * 覆盖「realpath 之后把路径换成外部软链接」「祖先目录整体 rename/替换」两类交换。
 */
async function verifyDesignSourcePath(
  params: DesignSourceFileParams,
  opened: OpenedDesignSource,
): Promise<boolean> {
  let currentRealPath: string;
  let currentStat: Awaited<ReturnType<typeof stat>>;
  let rootNow: FileIdentity;
  try {
    currentRealPath = await realpath(resolve(params.path));
    currentStat = await stat(currentRealPath);
    rootNow = await readRootIdentity(opened.rootPath);
  } catch {
    return false;
  }
  return (
    currentRealPath === opened.targetPath &&
    isWithinRoot(opened.rootPath, currentRealPath) &&
    currentStat.dev === opened.identity.dev &&
    currentStat.ino === opened.identity.ino &&
    rootNow.dev === opened.rootIdentity.dev &&
    rootNow.ino === opened.rootIdentity.ino
  );
}

export async function readDesignSourceFile(
  params: DesignSourceFileParams,
  authority?: DesignSourceAuthority,
): Promise<{ content: string }> {
  let opened: OpenedDesignSource | null = null;
  try {
    opened = await openDesignSource(params, READ_FLAGS, authority);
    return { content: await decodeHandleContent(opened.handle, opened.size) };
  } catch (error) {
    throw new DesignSourceFileError(reasonOf(error));
  } finally {
    await opened?.handle.close().catch(() => undefined);
  }
}

function withWriteLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  writeLocks.set(key, settled);
  void settled.finally(() => {
    if (writeLocks.get(key) === settled) writeLocks.delete(key);
  });
  return next;
}

async function writeHandleContent(handle: FileHandle, content: string): Promise<void> {
  const buffer = Buffer.from(content, "utf-8");
  // 原地写：保留文件身份、权限与硬链接计数；不创建临时文件或 rename。
  await handle.truncate(0);
  let written = 0;
  while (written < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      written,
      buffer.byteLength - written,
      written,
    );
    if (bytesWritten <= 0) throw new DesignSourceFileError("io_failed");
    written += bytesWritten;
  }
  // 必须确认数据真的落盘：fsync 失败要作为显式 IO 失败返回，而不是报告已写成功。
  await handle.sync();
}

export async function writeDesignSourceFile(
  params: WriteDesignSourceFileParams,
  authority?: DesignSourceAuthority,
): Promise<WriteDesignSourceFileResult> {
  if (
    Buffer.byteLength(params.content, "utf8") > DESIGN_SOURCE_MAX_BYTES ||
    Buffer.byteLength(params.expectedContent, "utf8") > DESIGN_SOURCE_MAX_BYTES
  ) {
    return { written: false, reason: "too_large" };
  }
  let opened: OpenedDesignSource | null = null;
  try {
    opened = await openDesignSource(params, WRITE_FLAGS, authority);
    const target = opened;
    return await withWriteLock(`${target.identity.dev}:${target.identity.ino}`, async () => {
      // 锁内再次复验：等锁期间路径可能被换成外部链接/另一个 inode。
      if (!(await verifyDesignSourcePath(params, target))) {
        return { written: false, reason: "invalid_path" };
      }
      let current: string;
      try {
        current = await decodeHandleContent(target.handle, target.size);
      } catch (error) {
        return { written: false, reason: reasonOf(error) };
      }
      if (current !== params.expectedContent) {
        return { written: false, reason: "changed" };
      }
      // 落盘前最后一次复验：只写已经验过「路径 → 同一 inode → 同一 root」的文件。
      if (!(await verifyDesignSourcePath(params, target))) {
        return { written: false, reason: "invalid_path" };
      }
      await writeHandleContent(target.handle, params.content);
      return { written: true };
    });
  } catch (error) {
    return { written: false, reason: reasonOf(error) };
  } finally {
    await opened?.handle.close().catch(() => undefined);
  }
}
