/**
 * 纯 Response/ReadableStream 的有界正文读取器。
 *
 * 匿名分享页（浏览器）与 Node 测试共用同一份实现：只用标准 Web API，不读文件、不建连接、
 * 不缓存网络策略。调用方负责请求本身（GET / credentials / referrer），这里只负责「最多读多少」。
 *
 * 两道闸门：
 * 1. 先看声明的 `Content-Length`，超限在读取前就取消 body；
 * 2. 分块响应没有可信长度，按累计字节数截止，越界立即 `reader.cancel()`，不把剩余字节读进内存。
 */

export type BoundedResponseBodyErrorKind = "limit_exceeded" | "invalid_content_length";

export class BoundedResponseBodyError extends Error {
  readonly kind: BoundedResponseBodyErrorKind;
  readonly maxBytes: number;
  readonly declaredBytes?: number;

  constructor(options: {
    kind: BoundedResponseBodyErrorKind;
    maxBytes: number;
    declaredBytes?: number;
    cause?: unknown;
  }) {
    super(
      options.kind === "limit_exceeded"
        ? "Response body exceeds the readable limit"
        : "Response body declares an invalid content length",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "BoundedResponseBodyError";
    this.kind = options.kind;
    this.maxBytes = options.maxBytes;
    if (options.declaredBytes !== undefined) this.declaredBytes = options.declaredBytes;
  }
}

function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
}

/** 读取响应正文；超过 `maxBytes` 时抛出 BoundedResponseBodyError 并取消底层流。 */
export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  assertMaxBytes(maxBytes);
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoundedResponseBodyError({
        kind: "invalid_content_length",
        maxBytes,
        declaredBytes: Number.isFinite(declared) ? declared : undefined,
      });
    }
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoundedResponseBodyError({
        kind: "limit_exceeded",
        maxBytes,
        declaredBytes: declared,
      });
    }
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // 超限立刻取消底层流：不把剩余字节读进内存，也不等服务器主动结束。
        await reader.cancel().catch(() => undefined);
        throw new BoundedResponseBodyError({ kind: "limit_exceeded", maxBytes });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 已确认在预算内的字节转 UTF-8 文本；不做无界 `response.text()`。 */
export function decodeBoundedResponseBodyText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}
