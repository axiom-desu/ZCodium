import { z } from "zod";
import {
  conversationArtifactTypeSchema,
  conversationRowSchema,
  type ConversationArtifactType,
  type ConversationRow,
} from "./zcode-protocol-v4/rows.js";
import type { Locale } from "./protocol.js";

/**
 * 分享站按语言分路径：中文站带 /cn 前缀，英文站是裸 /share。
 * web 路由、发布回链改写、导入回链共用这一份定义，避免三处各写一遍前缀。
 */
const CONVERSATION_SHARE_LOCALE_PATH_PREFIX: Readonly<Record<Locale, string>> = {
  "zh-CN": "/cn",
  "en-US": "",
};

const CONVERSATION_SHARE_PATHNAME_RE = /^\/(cn\/)?share\/([^/]+)\/?$/u;

/**
 * 解析分享页 pathname，返回未解码的 code 段与该路径对应的语言。
 * 只认 `/share/<code>` 与 `/cn/share/<code>` 两种形状；调用方负责 code 的解码与安全校验。
 */
export function parseConversationSharePathname(
  pathname: string,
): { rawCode: string; locale: Locale } | null {
  const match = CONVERSATION_SHARE_PATHNAME_RE.exec(pathname);
  if (!match) return null;
  return { rawCode: match[2]!, locale: match[1] ? "zh-CN" : "en-US" };
}

/**
 * 把分享链接改写到目标语言站点。
 *
 * 只在 pathname 精确匹配已知分享形状时改写，且只替换语言前缀、不碰 code 段
 * （避免 decode/encode 往返改变 code）。其它任何形状原样返回 —— 服务端将来若改用
 * 别的 URL 形状或独立域名，这里会安静地不作为，而不是改错。
 */
export function localizeConversationShareUrl(shareUrl: string, locale: Locale): string {
  let url: URL;
  try {
    url = new URL(shareUrl);
  } catch {
    return shareUrl;
  }
  const parsed = parseConversationSharePathname(url.pathname);
  if (!parsed) return shareUrl;
  url.pathname = `${CONVERSATION_SHARE_LOCALE_PATH_PREFIX[locale]}/share/${parsed.rawCode}`;
  return url.toString();
}

export const conversationShareAccessModeSchema = z.enum([
  "private",
  "public_readonly",
  "public_importable",
]);
export type ConversationShareAccessMode = z.infer<typeof conversationShareAccessModeSchema>;

/**
 * 本端产出与理解的公开载荷版本。
 *
 * 只有 rows 的语义发生「不可跳过的」破坏性变化时才 bump（新增 row kind / enum 值不算——
 * 那些由 decodeConversationShareRows 逐行降级消化）。
 */
export const CONVERSATION_SHARE_SCHEMA_VERSION = 1;

/**
 * 入站 schema_version 先按数字收下，再由本函数判定。
 * 版本高于本端认知时不猜语义：调用方必须转成「请升级」而不是通用契约错误。
 */
export function isConversationShareSchemaVersionSupported(version: number): boolean {
  return version <= CONVERSATION_SHARE_SCHEMA_VERSION;
}

/** 旧本地副本的未知行保留计数，避免升级/降级时静默丢失展示。 */
export function decodeConversationShareRows(rows: readonly unknown[]): {
  rows: ConversationRow[];
  unsupportedCount: number;
  unsupportedKinds: string[];
} {
  const decoded: ConversationRow[] = [];
  const unsupportedKinds: string[] = [];
  let unsupportedCount = 0;
  for (const row of rows) {
    const parsed = conversationRowSchema.safeParse(row);
    if (parsed.success) {
      decoded.push(parsed.data);
      continue;
    }
    unsupportedCount += 1;
    const kind = (row as { kind?: unknown } | null)?.kind;
    const label = typeof kind === "string" && kind.trim() ? kind.trim() : "unknown";
    if (!unsupportedKinds.includes(label)) unsupportedKinds.push(label);
  }
  return { rows: decoded, unsupportedCount, unsupportedKinds };
}

export const conversationShareSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const conversationShareArtifactDescriptorFields = {
  artifact_id: z.string().trim().min(1),
  logical_artifact_key: z.string().trim().min(1),
  producer_product_turn_id: z.string().trim().min(1),
  artifact_version: z.number().int().positive(),
  state: z.literal("current"),
  ref: z.string().regex(/^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u),
  artifact_type: conversationArtifactTypeSchema,
  display_name: z.string().trim().min(1),
  original_path: z.string().min(1).optional(),
  extension: z.string().trim().min(1),
  mime_type: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
} as const;

/** 公开文件描述符；本地归档进一步禁止 original_path。 */
export const conversationShareArtifactDescriptorSchema = z
  .object(conversationShareArtifactDescriptorFields)
  .strict();
export type ConversationShareArtifactDescriptor = z.infer<
  typeof conversationShareArtifactDescriptorSchema
>;

/** 随包文件格式的能力，供选择预检和附件快照使用。 */
export interface ConversationShareCapabilities {
  schema_version: number;
  max_rows: number;
  max_payload_bytes: number;
  max_artifact_count: number;
  max_artifact_bytes: number;
  max_total_artifact_bytes: number;
  allowed_artifacts: Array<{
    type: ConversationArtifactType;
    extensions: string[];
    mime_types: string[];
  }>;
  /** 服务端声明支持的公开内容块版本；缺席按「不支持任何版本」处理。 */
  content_block_versions?: Record<string, number>;
  /** 分享可用的访问模式；本地归档分享没有远端模式，缺席即只有私有副本。 */
  access_modes?: ConversationShareAccessMode[];
  /** 条目的存活时间；本地归档分享不适用。 */
  ttl_ms?: number;
}

/** 入站 descriptor（preview / continuation 回显）：允许服务端加字段。 */
export const conversationShareInboundArtifactDescriptorSchema = z.object(
  conversationShareArtifactDescriptorFields,
);

/** 入站 integrity：非 strict，服务端将来多带一个摘要字段不该打死响应。 */
export const conversationShareIntegritySchema = z.object({
  content_blocks_sha256: conversationShareSha256Schema.optional(),
  projection_sha256: conversationShareSha256Schema,
  artifact_set_sha256: conversationShareSha256Schema,
});
export type ConversationShareIntegrity = z.infer<typeof conversationShareIntegritySchema>;

const conversationSharePublicMetadataSchema = z.object({
  title: z.string(),
  access_mode: conversationShareAccessModeSchema,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
});

export const conversationSharePreviewArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    // 公开 URL 会进入链接、媒体及 fetch，不允许 API 响应启动其它协议。
    url: z
      .string()
      .url()
      .refine((url) => /^https?:\/\//iu.test(url)),
    url_expires_at: z.number().int().nonnegative(),
  });

/**
 * 入站 wire 形状：rows 是 unknown[]，由 decodeConversationShareRows 逐行降级。
 * 传输层不理解 row 语义是刻意的——否则老客户端遇到一行新 kind 就整份分享打不开。
 * 对外类型 ConversationSharePreview 是「解码后」的形状，不从这份 schema 推断。
 */
export const conversationSharePreviewDataSchema = z.object({
  schema_version: z.number().int().positive(),
  share: conversationSharePublicMetadataSchema,
  rows: z.array(z.unknown()),
  content_blocks: z.array(z.unknown()).optional(),
  artifacts: z.array(conversationSharePreviewArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationSharePreviewWire = z.infer<typeof conversationSharePreviewDataSchema>;
export type ConversationSharePreview = Omit<ConversationSharePreviewWire, "rows"> & {
  rows: ConversationRow[];
  /** 本端认不出、已跳过的行数；>0 时 UI 必须给「部分内容需要更新 ZCode 查看」软提示。 */
  unsupportedRowCount: number;
};

/** 本端已知的业务错误码；wire 上不做枚举校验，未知码保留服务端 msg 并落 unknown。 */
export const conversationShareKnownErrorCodeSchema = z.union([
  z.literal(3001),
  z.literal(3002),
  z.literal(3200),
  z.literal(3201),
  z.literal(3203),
  z.literal(3204),
  z.literal(3205),
  z.literal(3206),
  z.literal(3207),
  z.literal(3208),
  z.literal(3209),
  z.literal(3210),
  z.literal(3211),
  z.literal(3212),
  z.literal(3213),
  z.literal(3214),
  z.literal(3215),
  z.literal(3216),
  z.literal(3217),
]);
export type ConversationShareApiErrorCode = z.infer<typeof conversationShareKnownErrorCodeSchema>;

const SHARE_ERROR_KIND_BY_CODE = {
  3001: "invalid_contract",
  3002: "rate_limited",
  3200: "feature_disabled",
  3201: "authentication_required",
  3203: "unsupported_schema_version",
  3204: "invalid_contract",
  3205: "invalid_conversation",
  3206: "disclosure_required",
  3207: "unsafe_structure",
  3208: "artifact_not_allowed",
  3209: "limit_exceeded",
  3210: "upload_incomplete",
  3211: "not_found",
  3212: "expired",
  3213: "authentication_required",
  3214: "import_not_allowed",
  3215: "safety_check_pending",
  3216: "safety_check_rejected",
  3217: "safety_check_unavailable",
} as const satisfies Record<ConversationShareApiErrorCode, string>;

export type ConversationShareErrorKind =
  | (typeof SHARE_ERROR_KIND_BY_CODE)[ConversationShareApiErrorCode]
  | "service_unavailable"
  | "network"
  | "unknown";

/** 桌面与网页共享分类；错误码表达业务语义，未知码仍按 HTTP 判断服务故障。 */
export function classifyConversationShareError(
  status: number,
  code?: number,
): ConversationShareErrorKind {
  const known = conversationShareKnownErrorCodeSchema.safeParse(code);
  if (known.success) return SHARE_ERROR_KIND_BY_CODE[known.data];
  if (status === 401) return "authentication_required";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_unavailable";
  if (status === 403 || status === 404) return "not_found";
  if (status === 410) return "expired";
  if (status === 413) return "limit_exceeded";
  // HTTP 拒绝与响应契约损坏分开；仅成功响应缺少契约时归为 invalid_contract。
  return status >= 200 && status < 300 && code === undefined ? "invalid_contract" : "unknown";
}

const rejectionCoordinateSchema = z
  .string()
  .min(1)
  .max(65)
  .regex(/^[A-Za-z0-9_.[\]~-]+$/u);
export const conversationShareRejectionSchema = z.object({
  rule: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/u),
  path: rejectionCoordinateSchema.optional().catch(undefined),
  field: rejectionCoordinateSchema.optional().catch(undefined),
  row_index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
  row_kind: rejectionCoordinateSchema.optional().catch(undefined),
});
export type ConversationShareRejection = z.infer<typeof conversationShareRejectionSchema>;

export const conversationShareRequestIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);

/**
 * 错误信封对 code 不设枚举：后端上线一个新业务码时，老客户端应该照样能拿到服务端 msg，
 * 而不是整条信封解析失败、退化成没有上下文的 "HTTP 4xx"。
 */
export const conversationShareErrorEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  logid: conversationShareRequestIdSchema.optional().catch(undefined),
  data: conversationShareRejectionSchema.optional().catch(undefined),
});
export type ConversationShareErrorEnvelope = z.infer<typeof conversationShareErrorEnvelopeSchema>;

export function createConversationShareSuccessEnvelopeSchema<TSchema extends z.ZodType>(
  dataSchema: TSchema,
) {
  return z.object({
    code: z.literal(0),
    // msg 曾是 z.literal("")：后端哪天回个 "ok" 就会把所有成功响应判成契约错误。
    msg: z.string(),
    data: dataSchema,
  });
}
