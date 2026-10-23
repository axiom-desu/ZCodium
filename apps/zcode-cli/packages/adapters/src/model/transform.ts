// ============================================================
// Vercel AI SDK protocol transforms
// ============================================================

import { type ModelMessage as AiSdkModelMessage } from "ai";
import {
  ModelErrorCode,
  modelMessageContentToText,
  type ModelInputMessage,
  type ModelInputFormat,
} from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import {
  shouldTextifyStructuredToolResults,
  undeliverableFrameReferenceText,
  toToolResultMediaUserParts,
  toolResultHasVideoMedia,
} from "./tool-result-media-projection.js";
import { normalizeOpenAiCompatibleSystemMessages } from "./system-message-compat.js";
import {
  projectToolNameForProvider,
  shouldStripStoredReasoningForOpenAiResponsesStatelessReplay,
} from "./transform-policy.js";
import {
  providerOptionsForCacheControl,
  toAiSdkAssistantContent,
  toAiSdkToolResultOutput,
  toAiSdkUserContent,
  type AiSdkUserContent,
} from "./transform-parts.js";

export interface AiSdkMessageTransformOptions {
  apiFormat?: string;
  providerOptions?: Record<string, unknown>;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "google" | "gateway" | "custom";
  stripMedia?: boolean;
  inputFormat?: ModelInputFormat;
}

export function toAiSdkMessages(
  messages: ModelInputMessage[],
  options: AiSdkMessageTransformOptions = {},
): AiSdkModelMessage[] {
  const normalizedMessages =
    options.providerKind === "openai-compatible"
      ? normalizeOpenAiCompatibleSystemMessages(messages)
      : messages;
  const shouldStripOpenAiResponsesStoredReasoning =
    shouldStripStoredReasoningForOpenAiResponsesStatelessReplay(options);

  const transformedMessages: AiSdkModelMessage[] = [];
  let pendingToolMediaParts: Extract<AiSdkUserContent, unknown[]> = [];
  const textifyStructuredToolResults = shouldTextifyStructuredToolResults(options);
  const flushPendingToolMedia = () => {
    if (pendingToolMediaParts.length === 0) return;
    transformedMessages.push({ role: "user", content: pendingToolMediaParts });
    pendingToolMediaParts = [];
  };

  for (const message of normalizedMessages) {
    if (message.role !== "tool") {
      flushPendingToolMedia();
    }

    switch (message.role) {
      case "system":
        transformedMessages.push({
          role: "system",
          content: modelMessageContentToText(message.content),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;

      case "user":
        transformedMessages.push({
          role: "user",
          content: toAiSdkUserContent(message.content, options),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;

      case "assistant": {
        transformedMessages.push({
          role: "assistant",
          content: toAiSdkAssistantContent(message.content, message.toolCalls, {
            ...options,
            stripOpenAiResponsesStoredReasoning: shouldStripOpenAiResponsesStoredReasoning,
          }),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;
      }

      case "tool": {
        if (!message.toolCallId || message.toolName === undefined) {
          throw new AiSdkModelAdapterError(
            ModelErrorCode.InvalidModelRequest,
            "Tool model messages require toolCallId and toolName",
            { context: { role: message.role } },
          );
        }
        const toolName = projectToolNameForProvider(message.toolName, options);
        // 含 video 的 tool result 在所有 provider kind 上都强制 textify + 后置投影：
        // AI SDK tool result part 无 video 变体，anthropic 内嵌路径同样会丢失视频内容。
        const messageTextifyToolResult =
          textifyStructuredToolResults || toolResultHasVideoMedia(message.content);

        // 通用 fail-closed：帧引用结果在媒体不可投递时整体错误化（约束：
        // 引用文本不得与"媒体不可用"占位符同现，否则 actionable frame_id 会诱导
        // 模型对未见过画面的坐标产生动作）。
        const frameReferenceFailure = undeliverableFrameReferenceText(message.content, options);

        const toolMediaParts =
          frameReferenceFailure === undefined &&
          messageTextifyToolResult &&
          message.isError !== true
            ? toToolResultMediaUserParts(message.content, {
                ...options,
                toolName,
              })
            : [];
        transformedMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName,
              output: frameReferenceFailure
                ? { type: "error-text", value: frameReferenceFailure }
                : toAiSdkToolResultOutput(
                    message.content,
                    options,
                    message.isError === true,
                    messageTextifyToolResult,
                  ),
            },
          ],
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        pendingToolMediaParts.push(...toolMediaParts);
        break;
      }
    }
  }

  flushPendingToolMedia();
  return transformedMessages;
}
