import { CONVERSATION_ARCHIVE_LIMITS } from "./conversation-archive.js";

/**
 * 公开分享 artifact 的读取合同。
 *
 * 上限直接取归档合同里单个 artifact 的允许字节数，而不是另造一个更小的“防大响应”值：
 * 服务端能力声明的 `max_artifact_bytes` 与归档 manifest 的 `artifactBytes` 是同一个事实。
 * 读取实现必须使用 `readBoundedResponseBody`，避免 UI 再写一套网络/限额策略。
 */
export const CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES = CONVERSATION_ARCHIVE_LIMITS.artifactBytes;

export type ConversationShareArtifactSource =
  | { kind: "network"; url: string }
  | { kind: "data"; url: string };

/**
 * 只放行公开分享真正需要的两种来源：
 * - http(s)：契约校验过的公开 URL（含自托管/loopback 测试）；
 * - data：只允许本地解码，绝不交给浏览器发起网络请求。
 *
 * `javascript:` / `file:` / `zcode-artifact:` / `blob:` 等一律视为不可读取，调用方不得 fetch。
 */
export function classifyConversationShareArtifactUrl(
  value: string,
): ConversationShareArtifactSource | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return { kind: "network", url: parsed.toString() };
  }
  if (parsed.protocol === "data:") return { kind: "data", url: parsed.toString() };
  return null;
}

export type ConversationShareArtifactReadErrorKind =
  | "unsupported_url"
  | "limit_exceeded"
  | "invalid_payload"
  | "unavailable";

export class ConversationShareArtifactReadError extends Error {
  readonly kind: ConversationShareArtifactReadErrorKind;
  readonly status?: number;

  constructor(options: {
    kind: ConversationShareArtifactReadErrorKind;
    message: string;
    status?: number;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationShareArtifactReadError";
    this.kind = options.kind;
    if (options.status !== undefined) this.status = options.status;
  }
}

export interface ConversationShareArtifactReadResult {
  bytes: Uint8Array<ArrayBuffer>;
  mediaType?: string;
}

/**
 * 公开页注入给 UI 的 artifact 读取端口。
 *
 * UI 不实现网络策略；Web 落地页提供的实现必须只读 GET，并显式 credentials:omit /
 * referrerPolicy:no-referrer。`data:` 由 UI helper 本地解码，不会进入这个端口。
 */
export interface ConversationShareArtifactReader {
  read(
    url: string,
    options?: { signal?: AbortSignal },
  ): Promise<ConversationShareArtifactReadResult>;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

/** base64 的精确解码字节数；长度不是 4 的倍数时返回 undefined（payload 本身非法）。 */
function base64DecodedBytes(payload: string): number | undefined {
  if (payload.length % 4 !== 0) return undefined;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

/**
 * data URL 的廉价编码尺寸预算：必须在 `atob`/`decodeURIComponent` 分配之前判定。
 *
 * - base64：长度与 padding 能算出**精确**解码字节数，直接对比合同预算；
 * - percent-encoding：编码串每个字符最多贡献 3 个 UTF-8 字节（`%XX` 三字符→1 字节，
 *   字面非 ASCII 一字符→最多 3 字节），因此编码长度 / 3 是解码字节数的**下界**，
 *   下界已超预算就不必先解码再拒绝。
 * 预算就是调用方给的 `maxBytes`（默认合同值），不另造更小的“防大响应”值。
 */
function encodedDataUrlExceedsBudget(
  payload: string,
  isBase64: boolean,
  maxBytes: number,
): boolean {
  if (isBase64) {
    const decodedBytes = base64DecodedBytes(payload);
    return decodedBytes !== undefined && decodedBytes > maxBytes;
  }
  return payload.length / 3 > maxBytes;
}

/** 从已有 data: 字符串本地解码；不发起网络请求，结果仍受 artifact 预算约束。 */
export function decodeConversationShareDataUrl(
  value: string,
  maxBytes = CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES,
): ConversationShareArtifactReadResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (!value.startsWith("data:")) {
    throw new ConversationShareArtifactReadError({
      kind: "unsupported_url",
      message: "Artifact URL is not a data URL",
    });
  }
  const comma = value.indexOf(",");
  if (comma < 0) {
    throw new ConversationShareArtifactReadError({
      kind: "invalid_payload",
      message: "Artifact data URL is malformed",
    });
  }
  const metadata = value.slice("data:".length, comma);
  const payload = value.slice(comma + 1);
  const mediaType = metadata.split(";")[0]?.trim() || "text/plain";
  const isBase64 = /(?:^|;)base64(?:;|$)/iu.test(metadata);
  // 修复：过去先把整段 payload 解码完再比预算，明显超长的 data URL 仍会先分配
  // atob/解码字符串。现在先用编码长度判定，超预算直接按 limit_exceeded 拒绝。
  if (encodedDataUrlExceedsBudget(payload, isBase64, maxBytes)) {
    throw new ConversationShareArtifactReadError({
      kind: "limit_exceeded",
      message: "Artifact data URL exceeds the readable limit",
    });
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    if (isBase64) {
      if (!BASE64_PATTERN.test(payload) || base64DecodedBytes(payload) === undefined) {
        throw new Error("Invalid base64 payload");
      }
      const binary = atob(payload);
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
    } else {
      // data: 的 percent-encoding 先还原成文本，再按 UTF-8 编码；非法转义按坏载荷处理。
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
  } catch (cause) {
    throw new ConversationShareArtifactReadError({
      kind: "invalid_payload",
      message: "Artifact data URL could not be decoded",
      cause,
    });
  }
  if (bytes.byteLength > maxBytes) {
    throw new ConversationShareArtifactReadError({
      kind: "limit_exceeded",
      message: "Artifact data URL exceeds the readable limit",
    });
  }
  return { bytes, mediaType };
}
