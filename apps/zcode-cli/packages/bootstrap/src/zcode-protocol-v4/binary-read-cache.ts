import type { DynamicWorkflowRunArtifactBytes } from "@zcode/contracts";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";
import type { V4GatewayHost } from "./v4-gateway-contract.js";

/**
 * 一条已读回的**整份字节**，供分块读取复用。
 *
 * 两个家族共用这张表：已发送附件的预览（`readAttachment`）与 dwf 用户面产物的字节
 * （`readWorkflowArtifact`）。共用是有意的——两者的失效规则逐字相同（TTL、字节预算、
 * 最旧先逐、会话销毁时按 `sessionId` 清），而分成两张表会得到两份**各自**的字节预算，
 * 于是"最多缓存多少字节"这条约束就再也说不清了。
 *
 * 键空间靠**首段标签**区分（`att` / `dwfart`），不靠字段个数或内容——两个家族的键都是
 * NUL 分隔的四五段，段数相同、内容也可能撞（一个叫 "1" 的产物 id 与一个 attachmentIndex
 * 1 会长得一样），只有一个不可能相等的首段才是可证明的隔离。
 *
 * `bytes` 为 null 表示读还在飞：此时它不计入预算，也不会被按预算逐出（逐出一个正在被
 * await 的条目只会让下一块重新读一遍整份文件，正是这张表要消灭的事）。
 */
interface BinaryReadCacheEntry {
  sessionId: string;
  accessedAt: number;
  bytes: number | null;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}

/** 窄端口：只声明缓存真正使用的主机读取能力与时钟，由 gateway 组装。 */
interface BinaryReadCachePorts {
  now(): number;
  readSessionAttachment?: V4GatewayHost["readSessionAttachment"];
  readDynamicWorkflowRunArtifact?: V4GatewayHost["readDynamicWorkflowRunArtifact"];
}

export class BinaryReadCache {
  private readonly entries = new Map<string, BinaryReadCacheEntry>();
  private bytes = 0;

  constructor(private readonly ports: BinaryReadCachePorts) {}

  /**
   * 读取附件全部字节（带 TTL/容量缓存）。
   *
   * 注意语义：conversationAttachmentRead 的 offset/limit 是**切片**，不是流式读取——
   * 每个首次请求都会把整个附件物化进内存再切片，后续 chunk 命中同一份缓存。
   * 接入方不要把 chunk 协议当作「按需分段拉取」来规划超大文件；真正的 range 读取
   * 需要 host 侧 readBinaryFile 支持 offset（尚未实现）。
   */
  readAttachment(
    sessionId: string,
    ref: string,
    mime: string,
    messageId?: string,
    attachmentIndex?: number,
    allowGeneric = false,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const readSessionAttachment = this.ports.readSessionAttachment;
    if (!readSessionAttachment) throw new Error("fault.attachment.readUnsupported");
    const now = this.ports.now();
    this.prune(now);
    // 首段标签 `att`：这张表与 dwf 产物字节共用（见 BinaryReadCacheEntry），两个键空间
    // 只能靠一个不可能相等的首段隔离。
    const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
    const cached = this.entries.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    // 预览读取曾复用上传的 20MiB 总量上限；video 使用已有全局输入上限，
    // image 和上传事务继续保持原边界。
    const maxBytes = allowGeneric
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : mime.startsWith("video/")
        ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
        : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
    const payload = readSessionAttachment(sessionId, {
      ref,
      mime,
      maxBytes,
      ...(messageId ? { messageId } : {}),
      ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
    })
      .then((result) => {
        const resultMime = result.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (
          !allowGeneric &&
          !resultMime.startsWith("image/") &&
          !resultMime.startsWith("video/") &&
          resultMime !== "application/pdf"
        ) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
        }
        if (result.bytes.byteLength > maxBytes) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
        }
        const current = this.entries.get(key);
        if (current) {
          current.bytes = result.bytes.byteLength;
          this.bytes += result.bytes.byteLength;
          this.prune(this.ports.now());
        }
        return result;
      })
      .catch((error) => {
        this.deleteEntry(key);
        throw error;
      });
    this.entries.set(key, { sessionId, accessedAt: now, bytes: null, payload });
    return payload;
  }

  /**
   * 一个产物版本的**整份**字节，带缓存。
   *
   * 端口的 `readArtifact` 返回的是整份字节，而 `workflowRunArtifactRead` 是**分块**查询——
   * 不缓存的话，一个 20 MiB 的 PDF 按 512 KiB 分 40 块取，就会把整份文件从 store 读 40 遍
   * （800 MiB 的 I/O），而且每一块都要重走一遍 journal 授权链。
   *
   * 缓存的是 **promise 而不是结果**，且在发起前就写进表里：并发抓取的多个分块因此共享
   * 同一次读，而不是各自发起一次再各自写一遍缓存。
   *
   * 授权不因缓存被绕过：键里带着 `sessionId`，而 `sessionId` 正是端口那条授权链
   * （run 的 parentSessionId 必须等于它）的比对对象——换一个会话就是另一个键，必然重新
   * 走一次端口。会话销毁时按 `sessionId` 整片清掉，与附件同一条规则。
   *
   * 宿主回 `undefined`（不是你的 run / 无此版本 / 是块看板）在这里**抛错**而不是被缓存：
   * 走既有的 catch 分支把条目删掉，于是一个"发布刚落库、读稍微早了一步"的竞态不会被
   * 负缓存钉死 30 秒。
   */
  readWorkflowArtifact(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const readArtifact = this.ports.readDynamicWorkflowRunArtifact;
    if (!readArtifact) throw new Error("fault.workflowRunArtifactRead.unsupported");
    const now = this.ports.now();
    this.prune(now);
    // 首段标签 `dwfart`：与附件预览共用同一张表，靠首段隔离（见 BinaryReadCacheEntry）。
    const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
    const cached = this.entries.get(key);
    if (cached) {
      cached.accessedAt = now;
      return cached.payload;
    }

    const payload = readArtifact(params.sessionId, {
      runId: params.runId,
      artifactId: params.artifactId,
      version: params.version,
    })
      .then((artifact: DynamicWorkflowRunArtifactBytes | undefined) => {
        if (artifact === undefined) {
          throw new Error(
            `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
          );
        }
        const current = this.entries.get(key);
        if (current) {
          current.bytes = artifact.bytes.byteLength;
          this.bytes += artifact.bytes.byteLength;
          this.prune(this.ports.now());
        }
        // contentType 归一成表里的 mediaType 词汇；值仍是 journal 记录上的那一份
        // （UI 分派渲染器的精确匹配契约），不是 store 按文件名再推的那个。
        return { bytes: artifact.bytes, mediaType: artifact.contentType };
      })
      .catch((error: unknown) => {
        this.deleteEntry(key);
        throw error;
      });
    this.entries.set(key, {
      sessionId: params.sessionId,
      accessedAt: now,
      bytes: null,
      payload,
    });
    return payload;
  }

  prune(now = this.ports.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
        this.deleteEntry(key);
      }
    }
    if (this.bytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
    const oldest = [...this.entries.entries()]
      .filter(([, entry]) => entry.bytes !== null)
      .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
    for (const [key] of oldest) {
      this.deleteEntry(key);
      if (this.bytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
    }
  }

  clearSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.deleteEntry(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes = Math.max(0, this.bytes - (entry.bytes ?? 0));
  }
}
