import { z } from "zod";
import {
  conversationShareArtifactDescriptorSchema,
  conversationShareSha256Schema,
} from "./conversation-share.js";
import { conversationShareContentBlocksSchema } from "./conversation-share-content.js";
import { conversationRowSchema } from "./zcode-protocol-v4/rows.js";

export const CONVERSATION_ARCHIVE_LIMITS = Object.freeze({
  manifestBytes: 4 * 1024 * 1024,
  archiveBytes: 72 * 1024 * 1024,
  artifactBytes: 16 * 1024 * 1024,
  totalArtifactBytes: 64 * 1024 * 1024,
  artifacts: 128,
  rows: 5_000,
  jsonDepth: 64,
  jsonNodes: 250_000,
});

export const CONVERSATION_ARCHIVE_CHUNK_BYTES = 512 * 1024;

/** 本端可读写的归档格式上限；高于它的文件必须报 unsupported_version 而不是 invalid_archive。 */
export const CONVERSATION_ARCHIVE_MAX_VERSION = 2;

/** Host 内暂存的归档句柄，仅在创建它的连接内有效。 */
export interface ConversationArchiveExport {
  archiveId: string;
  suggestedName: string;
  byteLength: number;
}

export const conversationArchiveArtifactSchema = conversationShareArtifactDescriptorSchema
  .omit({ original_path: true })
  .extend({
    artifact_id: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/u),
    display_name: z.string().min(1).max(255),
    size_bytes: z.number().int().min(0).max(CONVERSATION_ARCHIVE_LIMITS.artifactBytes),
  })
  .strict();
export type ConversationArchiveArtifact = z.infer<typeof conversationArchiveArtifactSchema>;

/** 离线分享只携带用户选择的公开内容，不包含源路径、账号或运行时配置。 */
const conversationArchiveContentBaseFields = {
  format: z.literal("zcodium-conversation"),
  title: z.string().min(1).max(512),
  selectedProductTurnIds: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(CONVERSATION_ARCHIVE_LIMITS.rows),
  rows: z.array(conversationRowSchema).min(1).max(CONVERSATION_ARCHIVE_LIMITS.rows),
  artifacts: z.array(conversationArchiveArtifactSchema).max(CONVERSATION_ARCHIVE_LIMITS.artifacts),
} as const;

/**
 * 归档格式 v1 只能被原样重写（旧读取端严格拒绝未知字段），v2 才带公开内容块。
 * 两条分支都 strict：新增字段必须伴随版本 bump，不能靠 strip 静默丢数据。
 */
export const conversationArchiveContentSchema = z.discriminatedUnion("version", [
  z.object({ ...conversationArchiveContentBaseFields, version: z.literal(1) }).strict(),
  z
    .object({
      ...conversationArchiveContentBaseFields,
      version: z.literal(2),
      content_blocks: conversationShareContentBlocksSchema,
    })
    .strict(),
]);
export type ConversationArchiveContent = z.infer<typeof conversationArchiveContentSchema>;

export const conversationArchiveManifestSchema = z
  .object({
    content: conversationArchiveContentSchema,
    sha256: conversationShareSha256Schema,
  })
  .strict();

export type ConversationArchiveErrorCode =
  | "invalid_archive"
  | "unsupported_version"
  | "limit_exceeded"
  | "integrity_mismatch";
