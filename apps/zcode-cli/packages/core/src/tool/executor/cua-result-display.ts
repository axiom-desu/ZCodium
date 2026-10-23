// CUA（computer use）工具的 display 投影：把 MCP CUA 结果压成有限长、可渲染的 display。

import {
  CUA_TARGET_APP_DISPLAY_META_KEY,
  cuaTargetAppDisplaySchema,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "@zcode/zcode-cua/request-access-contract";
import { boundDisplayText } from "./display-text.js";
import { isRecord } from "./utils.js";

const MAX_CUA_DISPLAY_FIELD_BYTES = 32 * 1024;
const MAX_CUA_INLINE_MEDIA_BYTES = 256 * 1024;
const MAX_CUA_INLINE_MEDIA_TOTAL_BYTES = 512 * 1024;

export function readCuaToolName(toolName: string): string | undefined {
  // 兼容两种 CUA 工具命名：直接的 `mcp__computer_use__<action>` 与 plugin
  // 命名空间形式 `mcp__plugin_zcode-cua_computer-use__<action>`。
  // 归一化（小写 + `-`→`_`）后：名字包含 `computer_use`，且 action 是最后一个 `__` 之后的子串。
  const normalized = toolName.trim().toLowerCase().replaceAll("-", "_");
  if (!normalized.includes("computer_use")) return undefined;
  const lastSep = normalized.lastIndexOf("__");
  if (lastSep === -1) return undefined;
  const action = normalized.slice(lastSep + "__".length);
  return action.length > 0 ? action : undefined;
}

export function createCuaToolResultDisplay(
  toolName: string,
  output: unknown,
  officialCua: boolean,
): ToolResultDisplayPayload {
  const result = isRecord(output) ? output : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  const structuredContent = result.structuredContent;
  const structuredRecord = isRecord(structuredContent) ? structuredContent : undefined;
  const errorRecord = isRecord(structuredRecord?.error) ? structuredRecord.error : undefined;
  const structuredJson =
    structuredContent === undefined
      ? undefined
      : boundDisplayText(safeJson(structuredContent), MAX_CUA_DISPLAY_FIELD_BYTES);
  const boundedText = text ? boundDisplayText(text, MAX_CUA_DISPLAY_FIELD_BYTES) : undefined;
  // artifact URI 只在 Agent 本地可读，直接投影会让多端 UI 收到无法渲染的媒体。
  // 在受控读取 API 建立前，display 只承载可直接渲染的内联图片。
  const media: Array<{ mimeType: string; data: string }> = [];
  let inlineMediaBytes = 0;
  let mediaTruncated = false;
  for (const item of content) {
    if (!isRecord(item)) continue;
    let projectedMedia: { mimeType: string; data: string } | undefined;
    let decodedBytes = 0;
    if (
      item.type === "image" &&
      typeof item.mimeType === "string" &&
      typeof item.data === "string"
    ) {
      decodedBytes = Buffer.byteLength(item.data, "base64");
      projectedMedia = { mimeType: item.mimeType, data: item.data };
    }
    if (!projectedMedia) continue;
    // media 配额只约束真实媒体，前置 text block 不能吞掉截图位置。
    if (media.length >= 4) {
      mediaTruncated = true;
      break;
    }
    if (
      decodedBytes > MAX_CUA_INLINE_MEDIA_BYTES ||
      inlineMediaBytes + decodedBytes > MAX_CUA_INLINE_MEDIA_TOTAL_BYTES
    ) {
      mediaTruncated = true;
      continue;
    }
    inlineMediaBytes += decodedBytes;
    media.push(projectedMedia);
  }
  const truncated =
    mediaTruncated || structuredJson?.truncated === true || boundedText?.truncated === true;
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const targetApp = officialCua
    ? cuaTargetAppDisplaySchema.safeParse(meta?.[CUA_TARGET_APP_DISPLAY_META_KEY])
    : undefined;
  const permissionStatus =
    officialCua && toolName === "request_access"
      ? cuaRequestAccessStatusSchema.safeParse(meta?.[CUA_REQUEST_ACCESS_STATUS_META_KEY])
      : undefined;

  // MCP modelContent 会把 structuredContent 展平成文本；在展平前生成独立、有限长的
  // display，才能让实时事件和历史会话稳定区分 CUA 错误与结构化结果。
  return {
    kind: "cua",
    schemaVersion: 1,
    toolName,
    status: result.isError === true ? "failed" : "success",
    ...(structuredJson ? { structuredContent: structuredJson.value } : {}),
    ...(boundedText ? { text: boundedText.value } : {}),
    ...(typeof errorRecord?.code === "string" ? { errorCode: errorRecord.code } : {}),
    ...(typeof errorRecord?.suggested_action === "string"
      ? { suggestedAction: errorRecord.suggested_action }
      : {}),
    ...(targetApp?.success ? { targetApp: targetApp.data } : {}),
    ...(permissionStatus?.success ? { permissionStatus: permissionStatus.data } : {}),
    ...(media.length > 0 ? { media } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}
