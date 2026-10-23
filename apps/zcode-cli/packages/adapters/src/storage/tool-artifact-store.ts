import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ImageAttachmentPathPrimeRequest,
  MediaAttachmentPathPrimeRequest,
  MediaAttachmentPathEnsureRequest,
  MediaAttachmentPathResult,
  ToolBinaryArtifactWriteRequest,
  ToolArtifactStorePort,
  ToolArtifactReadRequest,
  ToolArtifactReadResult,
  ToolArtifactStatRequest,
  ToolArtifactStatResult,
  ToolArtifactWriteRequest,
  ToolArtifactWriteResult,
  ToolBinaryArtifactReadResult,
} from "@zcode/contracts";
import { maybeThrowStorageFsFault } from "./fs-fault-injection.js";
import {
  contentTypeForFileName,
  decodeMediaDataUrlArtifact,
  derivedMediaAttachmentPath,
  extensionForBinaryContentType,
  extensionForContentType,
  isPdfBytes,
  isRegularFile,
  isTextArtifactContentType,
  mediaKindForContentType,
  normalizeArtifactExtension,
  parseArtifactUri,
  sanitizePathSegment,
} from "./tool-artifact-codecs.js";

export interface NodeToolArtifactStoreOptions {
  imageCacheRootDir: string;
  pdfCacheRootDir?: string;
  rootDir: string;
  videoCacheRootDir: string;
}

export class NodeToolArtifactStore implements ToolArtifactStorePort {
  private readonly imageCacheRootDir: string;
  private readonly pdfCacheRootDir: string;
  private readonly rootDir: string;
  private readonly videoCacheRootDir: string;
  private readonly mediaAttachmentPathFlights = new Map<
    string,
    Promise<MediaAttachmentPathResult>
  >();

  constructor(options: NodeToolArtifactStoreOptions) {
    this.imageCacheRootDir = options.imageCacheRootDir;
    this.rootDir = options.rootDir;
    this.pdfCacheRootDir = options.pdfCacheRootDir ?? join(dirname(options.rootDir), "pdf-cache");
    this.videoCacheRootDir = options.videoCacheRootDir;
  }

  async writeToolResultArtifact(
    request: ToolArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact write cancelled");
    }

    const artifactId = `tool-result-${crypto.randomUUID()}`;
    const contentType = request.contentType ?? "application/json";
    const extension = extensionForContentType(contentType);
    const sessionDir = join(this.rootDir, sanitizePathSegment(request.sessionId));
    const fileName = `${sanitizePathSegment(String(request.toolCallId))}-${artifactId}${extension}`;
    const path = join(sessionDir, fileName);

    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    maybeThrowStorageFsFault({ operation: "writeFile", path });
    await writeFile(path, request.content, "utf8");

    return {
      id: artifactId,
      uri: `zcode-artifact://${encodeURIComponent(request.sessionId)}/${encodeURIComponent(artifactId)}`,
      path,
      bytes: Buffer.byteLength(request.content, "utf8"),
      contentType,
      createdAt: new Date(),
    };
  }

  async writeToolResultBinaryArtifact(
    request: ToolBinaryArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool binary artifact write cancelled");
    }

    const artifactId = `tool-result-${crypto.randomUUID()}`;
    const extension = normalizeArtifactExtension(
      request.extension ?? extensionForBinaryContentType(request.contentType),
    );
    const sessionDir = join(this.rootDir, sanitizePathSegment(request.sessionId));
    const fileName = `${sanitizePathSegment(String(request.toolCallId))}-${artifactId}${extension}`;
    const path = join(sessionDir, fileName);
    const content = Buffer.from(request.content);

    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    maybeThrowStorageFsFault({ operation: "writeFile", path });
    await writeFile(path, content);

    return {
      id: artifactId,
      uri: `zcode-artifact://${encodeURIComponent(request.sessionId)}/${encodeURIComponent(artifactId)}`,
      path,
      bytes: content.byteLength,
      contentType: request.contentType,
      createdAt: new Date(),
    };
  }

  async readToolResultArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact read cancelled");
    }

    const { path, contentType, bytes } = await this.readArtifactFile(request.uri);
    const content = isTextArtifactContentType(contentType)
      ? bytes.toString("utf8")
      : bytes.toString("base64");
    return {
      uri: request.uri,
      path,
      content,
      bytes: bytes.byteLength,
      contentType,
    };
  }

  /**
   * 直接读取原始字节，供 v4 分块查询和查看器使用，避免编解码改变内容。
   * contentType 仍按文件名推断，仅作兜底。
   */
  async readToolResultBinaryArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolBinaryArtifactReadResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact read cancelled");
    }
    const { path, contentType, bytes } = await this.readArtifactFile(request.uri);
    return { uri: request.uri, path, bytes: new Uint8Array(bytes), contentType };
  }

  /** 两条读回共用的定位 + 读文件：uri → 会话目录里含 artifactId 的那个文件。 */
  private async readArtifactFile(
    uri: string,
  ): Promise<{ path: string; contentType: string; bytes: Buffer }> {
    const { artifactId, sessionId } = parseArtifactUri(uri);
    const sessionDir = join(this.rootDir, sanitizePathSegment(sessionId));
    const entries = await readdir(sessionDir);
    const fileName = entries.find((entry) => entry.includes(artifactId));
    if (!fileName) {
      throw new Error(`Tool artifact not found: ${uri}`);
    }
    const path = join(sessionDir, fileName);
    return { path, contentType: contentTypeForFileName(fileName), bytes: await readFile(path) };
  }

  async statToolResultArtifact(
    request: ToolArtifactStatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactStatResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact stat cancelled");
    }
    const { artifactId, sessionId } = parseArtifactUri(request.uri);
    const sessionDir = join(this.rootDir, sanitizePathSegment(sessionId));
    const entries = await readdir(sessionDir);
    const fileName = entries.find((entry) => entry.includes(artifactId));
    if (!fileName) throw new Error(`Tool artifact not found: ${request.uri}`);
    const path = join(sessionDir, fileName);
    const artifactStat = await stat(path);
    return {
      uri: request.uri,
      bytes: artifactStat.size,
      contentType: contentTypeForFileName(fileName),
      path,
      mtimeMs: artifactStat.mtimeMs,
    };
  }

  primeImageAttachmentPath(
    request: ImageAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.primeMediaAttachmentPath(request);
  }

  primeMediaAttachmentPath(
    request: MediaAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.runMediaAttachmentPathFlight(request.uri, () =>
      this.writeDerivedMediaAttachment(request.uri, request.mediaType, Buffer.from(request.bytes)),
    );
  }

  ensureMediaAttachmentPath(
    request: MediaAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.runMediaAttachmentPathFlight(request.uri, async () => {
      const requestedPath = derivedMediaAttachmentPath(
        this.imageCacheRootDir,
        this.pdfCacheRootDir,
        this.videoCacheRootDir,
        request.uri,
        request.mediaType,
      );
      if (!requestedPath) return { status: "unsupported" };
      if (await isRegularFile(requestedPath)) return { status: "ready", path: requestedPath };

      const artifact = await this.readToolResultArtifact({ uri: request.uri });
      const decoded = decodeMediaDataUrlArtifact(
        artifact.content,
        request.uri,
        mediaKindForContentType(request.mediaType)!,
      );
      if (mediaKindForContentType(decoded.mediaType) === "pdf" && !isPdfBytes(decoded.bytes)) {
        throw new Error(`Media attachment artifact is not a PDF: ${request.uri}`);
      }
      return this.writeDerivedMediaAttachment(request.uri, decoded.mediaType, decoded.bytes);
    });
  }

  private runMediaAttachmentPathFlight(
    uri: string,
    materialize: () => Promise<MediaAttachmentPathResult>,
  ): Promise<MediaAttachmentPathResult> {
    const inFlight = this.mediaAttachmentPathFlights.get(uri);
    if (inFlight) return inFlight;

    // paste 落盘与紧随其后的发送会并发进入物化；URI 级 singleflight
    // 保证发送等待同一写任务，不会对同一派生媒体重复落盘。
    let flight!: Promise<MediaAttachmentPathResult>;
    flight = materialize().finally(() => {
      if (this.mediaAttachmentPathFlights.get(uri) === flight) {
        this.mediaAttachmentPathFlights.delete(uri);
      }
    });
    this.mediaAttachmentPathFlights.set(uri, flight);
    return flight;
  }

  private async writeDerivedMediaAttachment(
    uri: string,
    mediaType: string,
    bytes: Buffer,
  ): Promise<MediaAttachmentPathResult> {
    const path = derivedMediaAttachmentPath(
      this.imageCacheRootDir,
      this.pdfCacheRootDir,
      this.videoCacheRootDir,
      uri,
      mediaType,
    );
    // 既有媒体处理链可接收派生缓存无法命名的格式。
    // 派生 path 是增强信息，不支持该 MIME 时应跳过，不能阻断原 media/base64 请求。
    if (!path) return { status: "unsupported" };
    if (await isRegularFile(path)) return { status: "ready", path };

    const sessionDir = dirname(path);
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    try {
      maybeThrowStorageFsFault({ operation: "writeFile", path: temporaryPath });
      await writeFile(temporaryPath, bytes);
      maybeThrowStorageFsFault({ operation: "rename", path });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return { status: "ready", path };
  }
}

export function createNodeToolArtifactStore(
  options: NodeToolArtifactStoreOptions,
): ToolArtifactStorePort {
  return new NodeToolArtifactStore(options);
}
