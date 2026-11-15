import type { IPlatformService, SaveFileResult } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import type { FileCopySource } from "@/file-menu/contract.js";

/** 单次另存允许读取的最大字节数：超过就在读取前拒绝，不分配整文件。 */
export const MAX_FILE_COPY_BYTES = 50 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;

/**
 * 读取文件副本的完整字节。
 *
 * 顺序与拒绝条件（spec §3）：
 * 1. 先 `stat` 取 type/size/mtime；非文件、size 不可用直接失败；
 * 2. `> 50 MiB` 在读取前拒绝；
 * 3. 1 MiB 分块 `readFileRange`，块长为 0 或超长说明文件在读取中被改动；
 * 4. 再 `stat` 比对 size/mtime，避免把截断或旧内容当成功。
 */
export async function readFileCopy(source: FileCopySource, path: string): Promise<ArrayBuffer> {
  const before = await source.stat({ path });
  if (before.type !== "file") throw new Error("not_a_file");
  if (before.size === undefined || !Number.isSafeInteger(before.size) || before.size < 0) {
    throw new Error("file_size_unavailable");
  }
  const size = before.size;
  if (size > MAX_FILE_COPY_BYTES) throw new Error("file_too_large");
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(COPY_CHUNK_BYTES, size - offset);
    const chunk = await source.readFileRange({ path, offset, length });
    if (chunk.byteLength === 0 || chunk.byteLength > length) throw new Error("file_changed");
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const after = await source.stat({ path });
  if (after.type !== "file" || after.size !== size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("file_changed");
  }
  return bytes.buffer;
}

/** 先完整读取原字节再交给保存对话框，选择同一文件也不会先截断源文件。 */
export async function saveFileCopy(
  source: FileCopySource,
  path: string,
  save: NonNullable<IPlatformService["saveFile"]>,
): Promise<SaveFileResult> {
  const data = await readFileCopy(source, path);
  const result = await save({ data, suggestedName: getPathLeaf(path) || "download" });
  if (!result.success && !result.canceled) throw new Error(result.error || "save_failed");
  return result;
}

/** 浏览器只能确认交付下载，不能把 success 误报成已经写入磁盘；取消始终不提示。 */
export function fileSaveSuccessMessageId(
  result: SaveFileResult,
  canOpenLocalFiles?: boolean,
): string | null {
  if (!result.success || result.canceled) return null;
  return canOpenLocalFiles ? "fileActions.saved" : "fileActions.downloadStarted";
}
