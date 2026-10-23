import { VIDEO_INPUT_MAX_BYTES } from "@zcode/contracts";
import type {
  ImageProcessorPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnId,
} from "../deps.js";
import type { PreparedImageData, ResolvedTurnAttachment } from "../types.js";
import { persistAttachmentDataUrl } from "./attachment-artifacts.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { prepareImageDataUrl } from "./attachment-image.js";
import { parseInlineVideoDataUrl } from "./attachment-video.js";
import { parseInlinePdfDataUrl, PDF_INPUT_MAX_BYTES } from "./attachment-pdf.js";
import { resolvedPathReferenceAttachment } from "./attachment-path-reference.js";
import { resolveLocalMediaAttachment } from "./attachment-media-local.js";

// 本地媒体读取/编码实现已按职责提取；保留原 export 路径。
export { resolveLocalMediaAttachment } from "./attachment-media-local.js";

export interface InlineMediaResolverOptions {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  existingArtifactUri?: string;
  imageProcessorPort?: ImageProcessorPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
}

export async function resolveInlineMediaAttachment(
  attachment: TurnAttachment,
  index: number,
  parsedMediaType: string | undefined,
  options: InlineMediaResolverOptions,
): Promise<ResolvedTurnAttachment | undefined> {
  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  if (attachment.type === "image" && attachment.content && parsedMediaType?.startsWith("image/")) {
    let prepared: PreparedImageData | undefined;
    try {
      prepared = await prepareImageDataUrl(attachment.content, parsedMediaType, options);
    } catch {
      return resolvedPlaceholderAttachment(
        attachment,
        placeholder,
        "attachment_image_resize_failed",
      );
    }
    if (!prepared) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_image_invalid");
    }
    const resource = await persistAttachmentDataUrl(prepared.dataUrl, index, prepared.mediaType, {
      abortSignal: options.abortSignal,
      artifactStore: options.artifactStore,
      existingArtifactUri: options.existingArtifactUri,
      sessionId: options.sessionId,
      traceContext: options.traceContext,
      turnId: options.turnId,
    });
    return {
      contentBlock: {
        type: "image",
        mediaType: prepared.mediaType,
        dataUrl: prepared.dataUrl,
        source: {
          id: `turn-attachment-${index + 1}`,
          kind: "inline",
          mimeType: options.existingArtifactUri ? parsedMediaType : prepared.mediaType,
          placeholder,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      metadata: {
        ...(prepared.metadata ? { image: prepared.metadata } : {}),
        recoverability: resource.metadata.recoverability,
        sizeBytes: Buffer.byteLength(attachment.content, "utf8"),
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime: prepared.mediaType,
      url: resource.url,
    };
  }

  if (attachment.type === "pdf" && attachment.content) {
    const pdfData = parseInlinePdfDataUrl(attachment.content);
    if (!pdfData) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_pdf_invalid", {
        filename: attachment.filename,
        mime: "application/pdf",
        sizeBytes: attachment.sizeBytes,
      });
    }
    if (pdfData.sizeBytes === 0 || pdfData.sizeBytes > PDF_INPUT_MAX_BYTES) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_pdf_invalid", {
        filename: attachment.filename,
        mime: "application/pdf",
        sizeBytes: pdfData.sizeBytes,
      });
    }
    const resource = await persistAttachmentDataUrl(attachment.content, index, pdfData.mediaType, {
      abortSignal: options.abortSignal,
      artifactStore: options.artifactStore,
      existingArtifactUri: options.existingArtifactUri,
      sessionId: options.sessionId,
      traceContext: options.traceContext,
      turnId: options.turnId,
    });
    return {
      contentBlock: {
        type: "file",
        mediaType: pdfData.mediaType,
        name: attachment.filename,
        dataUrl: attachment.content,
        source: {
          id: `turn-attachment-${index + 1}`,
          kind: "inline",
          mimeType: pdfData.mediaType,
          placeholder,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      filename: attachment.filename,
      metadata: {
        recoverability: resource.metadata.recoverability,
        sizeBytes: pdfData.sizeBytes,
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime: pdfData.mediaType,
      url: resource.url,
    };
  }

  if (attachment.type !== "video" || !attachment.content) return undefined;

  const videoData = parseInlineVideoDataUrl(attachment.content);
  if (!videoData) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_video_invalid", {
      filename: attachment.filename,
      mime: attachment.mimeType ?? parsedMediaType ?? "video/*",
      sizeBytes: attachment.sizeBytes,
    });
  }
  // 空 payload 曾绕过视频大小校验并被持久化，导致实时与冷恢复消息形态不一致。
  if (videoData.sizeBytes === 0) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_video_invalid", {
      filename: attachment.filename,
      mime: videoData.mediaType,
      sizeBytes: videoData.sizeBytes,
    });
  }
  if (videoData.sizeBytes > VIDEO_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, placeholder, {
      filename: attachment.filename,
      mime: videoData.mediaType,
      sizeBytes: videoData.sizeBytes,
      reason: "video_too_large",
    });
  }
  const resource = await persistAttachmentDataUrl(attachment.content, index, videoData.mediaType, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    existingArtifactUri: options.existingArtifactUri,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "video",
      mediaType: videoData.mediaType,
      dataUrl: attachment.content,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "inline",
        mimeType: videoData.mediaType,
        placeholder,
        ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
      },
    },
    metadata: {
      recoverability: resource.metadata.recoverability,
      sizeBytes: videoData.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime: videoData.mediaType,
    url: resource.url,
  };
}
