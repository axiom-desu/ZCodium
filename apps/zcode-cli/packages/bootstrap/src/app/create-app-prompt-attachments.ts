import type { MessageId } from "@zcode/contracts";
import type { SessionId, SessionStorePort } from "@zcode/contracts";

export function decodePromptAttachmentDataUrl(
  content: string,
  fallbackMime: string,
  maxBytes: number,
): { bytes: Uint8Array; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = commaIndex >= 0 ? content.slice(commaIndex + 1) : "";
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  ) {
    throw new Error("fault.attachment.previewArtifactInvalid");
  }
  if (
    !mediaType.startsWith("image/") &&
    !mediaType.startsWith("video/") &&
    mediaType !== "application/pdf"
  ) {
    throw new Error("fault.attachment.previewNotMedia");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error("fault.attachment.previewTooLarge");
  }
  return { bytes, mediaType };
}

interface PromptAttachmentResolverInput {
  sessionId: SessionId;
  sessionStore: SessionStorePort;
}

export function createPromptAttachmentResolver(input: PromptAttachmentResolverInput) {
  const { sessionId, sessionStore } = input;
  const resolvePromptAttachment = async (input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ ref: string; mediaType: string; artifactUri?: string }> => {
    let ref = input.ref;
    let mediaType = input.mime;
    let artifactUri: string | undefined;
    if (input.messageId && input.attachmentIndex !== undefined) {
      // 预览单个附件曾通过 messages() 解码整段会话；长会话会同步扫描
      // 所有 parts，且无关坏行也会让目标预览失败。按 session/message 定点读取即可。
      const persistedMessage = await sessionStore.messageWithParts({
        sessionID: sessionId,
        messageID: input.messageId as MessageId,
      });
      const persistedAttachment = persistedMessage?.parts.filter((part) => part.type === "file")[
        input.attachmentIndex
      ];
      if (persistedAttachment?.type === "file") {
        mediaType = persistedAttachment.mime;
        // live row 的 ref 仍是原始路径；如果直接读取，源文件删除或覆盖后
        // 热态预览会和冷恢复 artifact 不一致。同一 message/index 必须优先取不可变副本。
        artifactUri =
          persistedAttachment.metadata?.artifactUri ??
          (persistedAttachment.url.startsWith("zcode-artifact://")
            ? persistedAttachment.url
            : undefined);
        ref =
          artifactUri ??
          (!persistedAttachment.url.startsWith("data:") ? persistedAttachment.url : input.ref);
      }
      // message row 会先于后续 FilePart 逐条落库；目标 part 尚未可见时仍应
      // 使用已经由当前 projection 授权的 input.ref，不能制造短暂的预览失败窗口。
    }
    return { ref, mediaType, ...(artifactUri ? { artifactUri } : {}) };
  };
  return resolvePromptAttachment;
}
