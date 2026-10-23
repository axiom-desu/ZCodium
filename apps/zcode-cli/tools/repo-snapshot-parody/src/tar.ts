/**
 * 最小 ustar 写入器 + gzip。零依赖，为了不往仓库里引包。
 *
 * 只实现本工具用得到的子集：普通文件、`ustar` 前缀拆分（>100 字符的长路径）、
 * 512 字节对齐、结尾两个零块。不处理硬链接、符号链接、设备节点——
 * 扫描阶段已经把这些排除了。
 */

import { createGzip } from "node:zlib";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

const BLOCK_SIZE = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE);

export interface TarEntry {
  /** 归档内路径，POSIX 分隔符。 */
  readonly path: string;
  /** 磁盘源路径。 */
  readonly absolutePath: string;
  readonly sizeBytes: number;
}

/** 定长八进制字段：`width - 1` 位八进制数字 + NUL。 */
function octalField(value: number, width: number): Buffer {
  const buf = Buffer.alloc(width);
  buf.writeUInt32BE(0); // 占位，下面整体覆写
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length > width - 1) {
    throw new Error(`tar 字段溢出：${value} 放不进 ${width} 字节`);
  }
  buf.write(text, 0, "ascii");
  buf[width - 1] = 0;
  return buf;
}

function stringField(value: string, width: number): Buffer {
  const buf = Buffer.alloc(width);
  if (value.length > width) {
    throw new Error(`tar 字符串字段溢出：${value.slice(0, 40)}… 超过 ${width}`);
  }
  buf.write(value, 0, "ascii");
  return buf;
}

/**
 * ustar 头。name 超 100 字符时优先按 `/` 拆成 name + prefix；
 * 拆不动（路径总长超过 256）就退化到 GNU `@LongLink` 扩展头——
 * 真仓库里 `.git` 与深层源码路径超过 256 字符并不罕见，不能因此丢掉文件。
 */
function buildHeader(
  entry: TarEntry,
  mtimeSeconds: number,
  displayPath: string,
  typeflag = "0",
): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  let name = displayPath;
  let prefix = "";

  if (name.length > 100) {
    const maxSuffix = 100;
    const searchFrom = name.length - maxSuffix - 1;
    const splitAt = searchFrom > 0 ? name.lastIndexOf("/", searchFrom) : -1;
    if (splitAt > 0 && splitAt <= 155) {
      prefix = name.slice(0, splitAt);
      name = name.slice(splitAt + 1);
    }
    // 拆不动时 name 保留前 100 字符，真实路径由 @LongLink 扩展头承载
  }

  let offset = 0;
  offset += stringField(name, 100).copy(header, offset);
  offset += octalField(0o644, 8).copy(header, offset); // mode
  offset += octalField(0, 8).copy(header, offset); // uid
  offset += octalField(0, 8).copy(header, offset); // gid
  offset += octalField(entry.sizeBytes, 12).copy(header, offset); // size
  offset += octalField(mtimeSeconds, 12).copy(header, offset); // mtime
  // chksum 先留 8 字节空格，算完再填
  const checksumOffset = offset;
  offset += 8;
  offset += stringField(typeflag, 1).copy(header, offset); // typeflag: 普通文件 / 'L' 长名
  offset += stringField("", 100).copy(header, offset); // linkname
  const magic = stringField("ustar", 6); // magic + NUL
  magic[5] = 0;
  offset += magic.copy(header, offset);
  offset += stringField("00", 2).copy(header, offset); // version
  offset += stringField("", 32).copy(header, offset); // uname
  offset += stringField("", 32).copy(header, offset); // gname
  offset += octalField(0, 8).copy(header, offset); // devmajor
  offset += octalField(0, 8).copy(header, offset); // devminor
  offset += stringField(prefix, 155).copy(header, offset); // prefix

  if (offset !== 500) {
    throw new Error(`tar 头部布局错误：offset=${offset}`);
  }

  // 校验和 = 头部全部字节（chksum 字段按 8 个空格算）之和
  for (let i = 0; i < 8; i += 1) header[checksumOffset + i] = 0x20;
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), checksumOffset, "ascii");
  header[checksumOffset + 6] = 0;
  header[checksumOffset + 7] = 0x20;

  return header;
}

const GNU_LONGNAME = "././@LongLink";
const GNU_LONGNAME_TYPE = "L";

/** GNU 长名扩展头：typeflag 'L'，内容为完整路径（NUL 结尾，按 512 对齐）。 */
function buildLongNameHeader(fullPath: string, mtimeSeconds: number): Buffer[] {
  const payload = Buffer.from(`${fullPath}\0`, "utf8");
  const blocks: Buffer[] = [
    buildHeader(
      { path: GNU_LONGNAME, absolutePath: GNU_LONGNAME, sizeBytes: payload.length },
      mtimeSeconds,
      GNU_LONGNAME,
      GNU_LONGNAME_TYPE,
    ),
  ];
  blocks.push(payload);
  const padding = (BLOCK_SIZE - (payload.length % BLOCK_SIZE)) % BLOCK_SIZE;
  if (padding > 0) blocks.push(Buffer.alloc(padding));
  return blocks;
}

export interface WriteTarGzResult {
  readonly fileCount: number;
  readonly plaintextBytes: number;
}

/**
 * 流式写 tar.gz：读文件 → tar 头 + 内容 → gzip → 落盘。
 * 不在内存里攒整包，`scan` 收上来的是整个工作区。
 */
export async function writeTarGz(
  entries: readonly TarEntry[],
  outputPath: string,
  options: { now?: () => number } = {},
): Promise<WriteTarGzResult> {
  const now = options.now ?? Date.now;
  const mtimeSeconds = Math.floor(now() / 1000);
  await mkdir(dirname(outputPath), { recursive: true });
  const output = createWriteStream(outputPath);
  const gzip = createGzip();

  let plaintextBytes = 0;
  try {
    await pipeline(
      async function* source() {
        for (const entry of entries) {
          if (entry.path.length > 100) {
            for (const block of buildLongNameHeader(entry.path, mtimeSeconds)) yield block;
          }
          yield buildHeader(entry, mtimeSeconds, entry.path.slice(0, 100));
          const blob = await openAsBlob(entry.absolutePath);
          const bytes = Buffer.from(await blob.arrayBuffer());
          if (bytes.length !== entry.sizeBytes) {
            throw new Error(
              `文件在扫描后发生变化：${entry.path}（清单 ${entry.sizeBytes}，实际 ${bytes.length}）`,
            );
          }
          yield bytes;
          const padding = (BLOCK_SIZE - (bytes.length % BLOCK_SIZE)) % BLOCK_SIZE;
          if (padding > 0) yield Buffer.alloc(padding);
          plaintextBytes += bytes.length;
        }
        yield ZERO_BLOCK;
        yield ZERO_BLOCK;
      },
      gzip,
      output,
    );
  } catch (error) {
    output.destroy();
    throw error;
  }

  return { fileCount: entries.length, plaintextBytes };
}

/** 供测试：单块的校验和与布局。 */
export const __testing = { buildHeader, octalField, BLOCK_SIZE, buildLongNameHeader };
