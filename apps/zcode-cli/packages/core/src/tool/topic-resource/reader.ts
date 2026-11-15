import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { MessageWithParts } from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import {
  READ_TOPIC_RESOURCE_TOOL_NAME,
  type ReadTopicResourceInput,
  type ReadTopicResourceOutput,
} from "./contract.js";

const dataUrlPattern = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;
const extensionPattern = /\.([a-zA-Z0-9]{1,12})$/;

/**
 * 只读当前会话：任务归属取本会话 id，模型不能自报。
 *
 * 接纳授权由 Host 的 bot 接纳归档裁决（`topicResourcePort`）；这里额外要求：
 * 会话已持久化过输入事实时，`inputId` 必须是本任务已接纳输入之一，
 * 不能拿另一轮的 id 拼到本次读取上。
 */
export async function readTopicResourceFromSession(
  messages: MessageWithParts[],
  input: ReadTopicResourceInput,
  context: ToolExecutionContext,
): Promise<ReadTopicResourceOutput> {
  context.abortSignal.throwIfAborted();
  const port = context.topicResourcePort;
  const store = context.artifactStore;
  if (!port || !store?.writeToolResultBinaryArtifact) {
    throw new Error("Topic attachment retrieval is unavailable on this runtime");
  }
  if (input.inputId) {
    const admitted = admittedInputIds(messages);
    if (admitted.size > 0 && !admitted.has(input.inputId)) {
      throw new Error("Resource is not indexed in the selected history snapshot");
    }
  }
  const index = input.index ?? 0;
  const options = { signal: context.abortSignal, trace: context.traceContext };
  const attachment = await port.read(
    {
      taskId: context.sessionId,
      ...(input.inputId ? { inputId: input.inputId } : {}),
      messageId: input.messageId,
      resourceIndex: index,
    },
    options,
  );
  context.abortSignal.throwIfAborted();
  validateAttachmentMetadata(attachment);
  const artifact = await store.readToolResultArtifact(
    { uri: attachment.ref, trace: options.trace },
    options,
  );
  const encoded = dataUrlPattern.exec(artifact.content);
  if (
    !encoded ||
    encoded[1] !== attachment.mime ||
    encoded[2]!.length > Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / 3) * 4
  ) {
    throw new Error("Invalid topic attachment artifact");
  }
  const bytes = Buffer.from(encoded[2]!, "base64");
  if (bytes.length !== attachment.bytes || bytes.toString("base64") !== encoded[2]) {
    throw new Error("Topic attachment size or encoding mismatch");
  }
  context.abortSignal.throwIfAborted();
  const result = await store.writeToolResultBinaryArtifact(
    {
      sessionId: context.sessionId,
      toolCallId: context.toolCallId,
      toolName: READ_TOPIC_RESOURCE_TOOL_NAME,
      content: bytes,
      contentType: attachment.mime,
      retention: "session",
      trace: options.trace,
      extension: extensionPattern.exec(attachment.fileName)?.[1]?.toLowerCase() ?? "bin",
    },
    options,
  );
  context.abortSignal.throwIfAborted();
  if (!result.path) throw new Error("Topic attachment could not be materialized");
  return {
    status: "success",
    path: result.path,
    fileName: attachment.fileName,
    mime: attachment.mime,
    bytes: attachment.bytes,
    messageId: input.messageId,
    index,
  };
}

function validateAttachmentMetadata(attachment: {
  ref: string;
  fileName: string;
  mime: string;
  bytes: number;
}): void {
  if (!attachment.ref) throw new Error("Topic attachment reference is unavailable");
  if (!Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0) {
    throw new Error("Invalid topic attachment size");
  }
  if (attachment.bytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
    throw new Error("Invalid topic attachment size");
  }
  if (!attachment.fileName || !attachment.mime) {
    throw new Error("Invalid topic attachment metadata");
  }
}

/** 冷恢复与旧会话可能没有 intent metadata；有则必须来自本任务真实用户输入。 */
function admittedInputIds(messages: MessageWithParts[]): Set<string> {
  const ids = new Set<string>();
  for (const { info } of messages) {
    if (info.role !== "user" || info.synthetic) continue;
    const metadata = info.metadata as Record<string, unknown> | undefined;
    const intent =
      metadata && Object.hasOwn(metadata, "conversationInputIntent")
        ? metadata.conversationInputIntent
        : metadata?.inputIntent;
    if (!intent || typeof intent !== "object") continue;
    const sourceCommandId = (intent as { sourceCommandId?: unknown }).sourceCommandId;
    if (typeof sourceCommandId === "string" && sourceCommandId.length > 0) {
      ids.add(sourceCommandId);
    }
  }
  return ids;
}
