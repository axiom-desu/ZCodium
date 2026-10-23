import { isRecord, numberValue, stringValue } from "./sources.js";
import type { DbMessageRecord, DbPartRecord, EventRecord } from "./types.js";
import type { TimelineItem } from "../src/shared.js";

export function extractUsage(payload?: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const usage = isRecord(payload?.usage) ? payload.usage : payload;
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  return {
    inputTokens: numberValue(usage.inputTokens) ?? numberValue(usage.input) ?? 0,
    outputTokens: numberValue(usage.outputTokens) ?? numberValue(usage.output) ?? 0,
    totalTokens: numberValue(usage.totalTokens) ?? numberValue(usage.total) ?? 0,
    cacheReadTokens:
      numberValue(usage.cacheReadTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.read : undefined) ??
      0,
    cacheWriteTokens:
      numberValue(usage.cacheWriteTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.write : undefined) ??
      0,
  };
}

function textFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  return (
    textFromContent(payload.content) ??
    textFromContent(payload.text) ??
    textFromContent(payload.message)
  );
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        return textFromContent(part.text) ?? textFromContent(part.content) ?? "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (isRecord(content)) {
    return textFromContent(content.text) ?? textFromContent(content.content);
  }
  return undefined;
}

export function firstUserMessageFromEvent(event: EventRecord): string | undefined {
  if (event.type === "user_message") {
    return textFromPayload(event.payload);
  }

  const messages = arrayValue(event.payload?.messages).filter(isRecord);
  const userMessage = messages.find((message) => stringValue(message.role) === "user");
  return userMessage ? textFromPayload(userMessage) : undefined;
}

export function textFromDbMessage(message: DbMessageRecord): string | undefined {
  return textFromPayload(message.data);
}

export function textFromDbParts(parts: DbPartRecord[] | undefined): string | undefined {
  const textParts = parts
    ?.map((part) => textFromPayload(part.data))
    .filter((text): text is string => Boolean(text?.trim()));
  if (!textParts || textParts.length === 0) return undefined;
  return textParts.join("\n");
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringifyTimelineValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function preview(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

export function estimateTokens(text: string): number {
  const chineseChars = text.match(/[一-鿿]/g)?.length ?? 0;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / 3);
}

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

export function eventToolCallId(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolCallId);
}

export function eventToolName(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolName) ?? stringValue(payload?.name);
}

export function subagentLabel(event: EventRecord): string {
  return (
    stringValue(event.payload?.name) ??
    stringValue(event.payload?.subagentId) ??
    stringValue(event.payload?.subagentSessionId) ??
    "子 Agent"
  );
}

export function modelName(payload?: Record<string, unknown>): string | undefined {
  const modelSelection = isRecord(payload?.modelSelection) ? payload.modelSelection : undefined;
  return stringValue(modelSelection?.modelId) ?? stringValue(payload?.model);
}

export function formatRole(role?: string): string {
  switch (role) {
    case "system":
      return "system ";
    case "user":
      return "user ";
    case "assistant":
      return "assistant ";
    case "tool":
      return "tool ";
    default:
      return "";
  }
}

export function normalizeLogLevel(level?: string): TimelineItem["severity"] {
  switch (level) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      return undefined;
  }
}

export function summarizeEvent(event: EventRecord): string {
  const payload = event.payload;
  switch (event.type) {
    case "model_request": {
      const title = `模型请求 ${modelName(payload) ?? ""}`.trim();
      const messages = summarizeProviderMessages(payload);
      return messages ? `${title}\n${messages}` : title;
    }
    case "model_complete": {
      const usage = extractUsage(payload);
      const title = `模型完成，${usage.totalTokens || usage.inputTokens + usage.outputTokens} Token`;
      const content = textFromPayload(payload);
      return content ? `${title}\n${content}` : title;
    }
    case "tool_call_scheduled":
    case "tool_call_started":
    case "tool_call_result":
    case "tool_call_error":
      return [
        `${stringValue(payload?.toolName) ?? "工具"} ${stringValue(payload?.toolCallId) ?? ""}`.trim(),
        textFromPayload(payload),
      ]
        .filter(Boolean)
        .join("\n");
    case "turn_complete":
      return `轮次完成：${stringValue(payload?.resultType) ?? "success"}`;
    case "user_message":
    case "assistant_message":
      return textFromPayload(payload) ?? String(payload?.content ?? event.type);
    default:
      return [event.type, textFromPayload(payload)].filter(Boolean).join("\n");
  }
}

export function summarizeDbMessage(message: DbMessageRecord): string {
  const text = stringValue(message.data.text) ?? stringValue(message.data.content);
  const title = `${formatRole(message.role)}消息 ${message.id}`;
  return text ? `${title}: ${text}` : title;
}

export function summarizeDbPart(part: DbPartRecord): string {
  const text = stringValue(part.data.text) ?? stringValue(part.data.output);
  return text ? `${part.type ?? "片段"}: ${text}` : `${part.type ?? "片段"} ${part.id}`;
}

function summarizeProviderMessages(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const messages = arrayValue(payload?.messages).filter(isRecord);
  if (messages.length === 0) return undefined;

  return messages
    .map((message, index) => {
      const role = stringValue(message.role) ?? `message ${index + 1}`;
      const content = textFromPayload(message) ?? stringifyTimelineValue(message);
      return `${role}: ${content}`;
    })
    .join("\n");
}

export function compareIsoAsc(left?: string, right?: string): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
}

export function compareIsoDesc(left?: string, right?: string): number {
  return compareIsoAsc(right, left);
}
