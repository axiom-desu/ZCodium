import { open } from "node:fs/promises";

export async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readAtMostBytes(
  path: string,
  maxBytes: number,
  initialSizeBytes: number,
): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    // 稳定文件按 stat 大小一次读取；只有文件在 stat 后增长时才继续分块追到硬上限。
    const firstBuffer = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(1, initialSizeBytes + 1)));
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal < maxBytes) {
      const chunk =
        bytesReadTotal === 0
          ? firstBuffer
          : Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytesReadTotal));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, bytesReadTotal);
      // FileHandle.read 的短读不等于 EOF；只有明确返回 0 字节才能停止。
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    if (chunks.length === 0) return Buffer.alloc(0);
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytesReadTotal);
  } finally {
    await handle.close();
  }
}
