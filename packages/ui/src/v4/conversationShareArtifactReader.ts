import {
  CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES,
  ConversationShareArtifactReadError,
  classifyConversationShareArtifactUrl,
  decodeConversationShareDataUrl,
  type ConversationShareArtifactReadResult,
  type ConversationShareArtifactReader,
} from "@zcode/shared";

/**
 * UI 侧的 artifact 读取入口。
 *
 * 网络策略不在这里复制：http(s) 必须交给公开页注入的 reader（由 Web 落地页实现
 * GET + credentials:omit + no-referrer），UI 只做两件事：
 * - `data:` 从已有字符串本地解码，绝不发起网络；
 * - object URL 按代次创建/撤销，避免旧分享的迟到结果覆盖当前卡片或泄漏 Blob。
 */
/** 公开页/宿主注入的 artifact URL 也要过协议白名单，避免 javascript:/file: 落进 href/src。 */
export function sanitizeConversationShareArtifactUrls(
  urls: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const safe = new Map<string, string>();
  for (const [id, url] of urls) {
    if (classifyConversationShareArtifactUrl(url)) safe.set(id, url);
  }
  return safe;
}

export async function readConversationShareArtifactBytes(
  url: string,
  reader: ConversationShareArtifactReader | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<ConversationShareArtifactReadResult> {
  const source = classifyConversationShareArtifactUrl(url);
  if (!source) {
    throw new ConversationShareArtifactReadError({
      kind: "unsupported_url",
      message: "Artifact URL uses an unsupported protocol",
    });
  }
  if (source.kind === "data") {
    return decodeConversationShareDataUrl(source.url, CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES);
  }
  if (!reader) {
    throw new ConversationShareArtifactReadError({
      kind: "unavailable",
      message: "No anonymous artifact reader was injected",
    });
  }
  return reader.read(source.url, options);
}

interface ConversationShareArtifactObjectUrlLease {
  generation: number;
  url: string;
}

/**
 * object URL 的唯一生命周期 owner。
 *
 * 每次分享范围/URL 变化都开启新代次；只有「当前代次」的读取结果能创建 URL。旧代次的迟到结果
 * 只会被丢弃，不会覆盖当前内容；撤销时也只撤销自己那一代的 URL。
 */
export class ConversationShareArtifactObjectUrlScope {
  private generation = 0;
  private current: ConversationShareArtifactObjectUrlLease | null = null;

  beginGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  replace(generation: number, blob: Blob): string | null {
    if (!this.isCurrent(generation)) return null;
    this.revokeCurrent();
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    const url = URL.createObjectURL(blob);
    this.current = { generation, url };
    return url;
  }

  release(generation: number): void {
    if (this.current?.generation !== generation) return;
    this.revokeCurrent();
  }

  dispose(): void {
    this.generation += 1;
    this.revokeCurrent();
  }

  private revokeCurrent(): void {
    const current = this.current;
    this.current = null;
    if (current === null) return;
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(current.url);
    }
  }
}
