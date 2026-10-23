import { isAbsolute } from "node:path";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  FileSystemPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
} from "@zcode/contracts";
import type { ZCodeApp } from "./types.js";
import { decodePromptAttachmentDataUrl } from "./create-app-prompt-attachments.js";
import type { createPromptAttachmentResolver } from "./create-app-prompt-attachments.js";

interface AppAttachmentsSurfaceInput {
  artifactStore: ToolArtifactStorePort;
  fileSystemPort: FileSystemPort;
  resolvePromptAttachment: ReturnType<typeof createPromptAttachmentResolver>;
  sessionId: SessionId;
  traceContext: TraceContext;
}

export function createAttachmentsSurface(
  input: AppAttachmentsSurfaceInput,
): Pick<
  ZCodeApp,
  | "readToolResultArtifact"
  | "writePromptAttachment"
  | "readPromptAttachment"
  | "statPromptAttachment"
  | "resolvePromptAttachmentPreviewSource"
> {
  const { artifactStore, fileSystemPort, resolvePromptAttachment, sessionId, traceContext } = input;
  return {
    readToolResultArtifact: (uri) =>
      artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
    // wire/staging 全程是 decoded chunk；只有完整 checksum commit 后才在
    // CLI 进程内恢复既有 data-URL artifact 形态，保持 provider 读取链兼容。
    writePromptAttachment: async (input) => {
      const artifact = await artifactStore.writeToolResultArtifact({
        content: `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
        sessionId,
        toolCallId: `prompt-attachment-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        toolName: "prompt-attachment:upload",
        trace: traceContext,
      });
      if (
        input.mime.startsWith("image/") ||
        input.mime.startsWith("video/") ||
        input.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
      ) {
        // 派生媒体只是可重建缓存；真实 IO 失败不破坏 durable data URL，最终请求投影会再次 ensure。
        void artifactStore
          .primeMediaAttachmentPath?.({
            bytes: input.bytes,
            mediaType: input.mime,
            uri: artifact.uri,
          })
          .catch(() => undefined);
      }
      return { ref: artifact.uri };
    },
    readPromptAttachment: async (input) => {
      const { ref, mediaType } = await resolvePromptAttachment(input);
      // 读取必须留在 session runtime 内：artifact 走 session store，路径走当前
      // FileSystemPort，SSH/WSL/Docker 才会命中正确的远端文件系统。
      if (ref.startsWith("zcode-artifact://")) {
        const artifact = await artifactStore.readToolResultArtifact({
          uri: ref,
          trace: traceContext,
        });
        return decodePromptAttachmentDataUrl(artifact.content, mediaType, input.maxBytes);
      }
      const read = await fileSystemPort.readBinaryFile({
        path: ref,
        maxBytes: input.maxBytes,
        trace: traceContext,
      });
      return { bytes: read.content, mediaType };
    },
    statPromptAttachment: async (input) => {
      const { ref, mediaType, artifactUri } = await resolvePromptAttachment(input);
      if (artifactUri) {
        if (!artifactStore.statToolResultArtifact) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
        }
        const result = await artifactStore.statToolResultArtifact({
          uri: artifactUri,
          trace: traceContext,
        });
        return {
          totalBytes: result.bytes,
          mediaType: result.contentType || mediaType,
          ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
        };
      }
      const result = await fileSystemPort.stat({ path: ref, trace: traceContext });
      if (result.kind !== "file") {
        // 目录/符号链接/已消失都意味着「这个附件不再是可分享的文件」，用稳定码上抛，
        // 让 share 预检按确定分类处理，而不是靠错误文本猜。
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statNotFile);
      }
      return {
        totalBytes: result.sizeBytes,
        mediaType,
        ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
      };
    },
    resolvePromptAttachmentPreviewSource: async (input) => {
      const resolved = await resolvePromptAttachment(input);
      if (!resolved.mediaType.startsWith("video/")) return { kind: "chunked" };
      if (resolved.artifactUri) {
        if (!artifactStore.ensureMediaAttachmentPath) return { kind: "chunked" };
        try {
          const materialized = await artifactStore.ensureMediaAttachmentPath({
            uri: resolved.artifactUri,
            mediaType: resolved.mediaType,
          });
          if (materialized.status === "ready" && materialized.path.trim()) {
            return {
              kind: "local_path",
              path: materialized.path,
              mediaType: resolved.mediaType,
            };
          }
        } catch {
          // artifact 仍是不可变事实；派生文件失败只允许 gateway 回到 artifact chunk。
        }
        return { kind: "chunked" };
      }
      if (isAbsolute(resolved.ref)) {
        return {
          kind: "local_path",
          path: resolved.ref,
          mediaType: resolved.mediaType,
        };
      }
      return { kind: "chunked" };
    },
  };
}
