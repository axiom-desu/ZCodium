import { createHash } from "node:crypto";
import {
  CONVERSATION_ARCHIVE_LIMITS as LIMITS,
  CONVERSATION_ARCHIVE_MAX_VERSION,
  conversationArchiveManifestSchema,
  type ConversationArchiveContent,
  type ConversationArchiveErrorCode,
} from "@zcode/shared";
import { sha256ConversationShareJson } from "./conversationShareIntegrity.js";
import { buildConversationSharePublicProjection } from "./conversationSharePublicProjection.js";

/** 错误不回显不可信文件内容或底层 ZIP/JSON 异常中的路径。 */
export class ConversationArchiveError extends Error {
  constructor(readonly code: ConversationArchiveErrorCode) {
    super(`Conversation archive: ${code}`);
    this.name = "ConversationArchiveError";
  }
}

export function archiveSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertArchiveJsonBounds(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > LIMITS.jsonNodes || current.depth > LIMITS.jsonDepth) {
      throw new ConversationArchiveError("limit_exceeded");
    }
    if (current.value && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

export function validateArchiveManifest(input: unknown): ConversationArchiveContent {
  assertArchiveJsonBounds(input);
  if (input && typeof input === "object" && "content" in input) {
    const content = input.content;
    if (
      content &&
      typeof content === "object" &&
      "format" in content &&
      content.format === "zcodium-conversation" &&
      "version" in content &&
      typeof content.version === "number" &&
      (content.version < 1 || content.version > CONVERSATION_ARCHIVE_MAX_VERSION)
    ) {
      throw new ConversationArchiveError("unsupported_version");
    }
  }
  const parsed = conversationArchiveManifestSchema.safeParse(input);
  if (!parsed.success)
    throw new ConversationArchiveError(
      parsed.error.issues.some((issue) => issue.code === "too_big")
        ? "limit_exceeded"
        : "invalid_archive",
    );
  // Row schema 允许兼容性字段裁剪；离线文件 v1 必须拒绝未知字段，不能悄悄丢数据。
  if (sha256ConversationShareJson(input) !== sha256ConversationShareJson(parsed.data)) {
    throw new ConversationArchiveError("invalid_archive");
  }
  const { content, sha256 } = parsed.data;
  if (sha256ConversationShareJson(content) !== sha256) {
    throw new ConversationArchiveError("integrity_mismatch");
  }
  const rowArtifacts = new Set(
    content.rows.flatMap((row) => (row.kind === "artifact" ? [row.artifactVersionId] : [])),
  );
  const projected = buildConversationSharePublicProjection({
    rows: content.rows,
    selectedProductTurnIds: content.selectedProductTurnIds,
    additionalArtifacts: content.artifacts
      .filter((artifact) => !rowArtifacts.has(artifact.artifact_id))
      .map((descriptor) => ({ descriptor, sourceRef: descriptor.ref })),
  });
  // 同一公开投影白名单也用于导入，避免只检查 ID 却漏过已知 schema 内的私有字段。
  if (sha256ConversationShareJson(projected.rows) !== sha256ConversationShareJson(content.rows)) {
    throw new ConversationArchiveError("invalid_archive");
  }
  validateArtifactReferences(content);
  validateContentBlockReferences(content);
  return content;
}

/**
 * 内容块只能引用同一份公开投影里的行与结果物。
 *
 * 校验放在归档边界而不是只靠渲染端：块是公开 payload，引用不到的行/结果物会让回退
 * 摘要与图片资源悬空（老读取端认不出块时只剩下不存在的 fallback_row_id）。
 */
function validateContentBlockReferences(content: ConversationArchiveContent): void {
  if (content.version !== 2) return;
  const blocks = content.content_blocks;
  const invalid = () => {
    throw new ConversationArchiveError("invalid_archive");
  };
  const ids = new Set<string>();
  const artifactIds = new Set(content.artifacts.map((artifact) => artifact.artifact_id));
  const rowsById = new Map(content.rows.map((row) => [row.rowId, row] as const));
  for (const block of blocks) {
    if (ids.has(block.id)) invalid();
    ids.add(block.id);
    if (!content.selectedProductTurnIds.includes(block.product_turn_id)) invalid();
    const fallback = rowsById.get(block.fallback_row_id);
    const expectedKind = block.type === "tool-presentation" ? "toolCall" : "assistantText";
    if (
      fallback === undefined ||
      fallback.productTurnId !== block.product_turn_id ||
      fallback.kind !== expectedKind
    )
      invalid();
    if (block.resource_ids.some((id) => !artifactIds.has(id))) invalid();
    if (block.type === "workflow") {
      for (const artifact of block.payload.artifacts) {
        if ("resource_id" in artifact && artifact.resource_id !== undefined) {
          if (!artifactIds.has(artifact.resource_id)) invalid();
        }
      }
    }
  }
}

function validateArtifactReferences(content: ConversationArchiveContent): void {
  const byRef = new Map(content.artifacts.map((artifact) => [artifact.ref, artifact]));
  const ids = new Set(content.artifacts.map((artifact) => artifact.artifact_id));
  const referenced = new Set<string>();
  const invalid = () => {
    throw new ConversationArchiveError("invalid_archive");
  };
  if (ids.size !== content.artifacts.length || byRef.size !== ids.size) invalid();
  let total = 0;
  for (const artifact of content.artifacts) {
    if (
      !content.selectedProductTurnIds.includes(artifact.producer_product_turn_id) ||
      artifact.ref !== `zcode-artifact://share/${artifact.artifact_id}`
    )
      invalid();
    total += artifact.size_bytes;
  }
  if (total > LIMITS.totalArtifactBytes) throw new ConversationArchiveError("limit_exceeded");
  for (const row of content.rows) {
    if (row.kind === "artifact") {
      const artifact = byRef.get(row.ref);
      if (
        !artifact ||
        artifact.artifact_id !== row.artifactVersionId ||
        artifact.logical_artifact_key !== row.logicalArtifactKey ||
        artifact.producer_product_turn_id !== row.productTurnId ||
        artifact.artifact_type !== row.artifactType ||
        artifact.display_name !== row.displayName ||
        artifact.mime_type !== row.mimeType ||
        artifact.size_bytes !== row.sizeBytes ||
        artifact.sha256 !== row.sha256
      )
        invalid();
      referenced.add(row.ref);
    }
    if (row.kind === "userInput")
      for (const attachment of row.attachments ?? []) {
        const artifact = byRef.get(attachment.ref);
        if (
          !artifact ||
          artifact.producer_product_turn_id !== row.productTurnId ||
          artifact.size_bytes !== attachment.bytes ||
          artifact.mime_type !== attachment.mime ||
          artifact.display_name !== attachment.fileName
        )
          invalid();
        referenced.add(attachment.ref);
        if (attachment.previewRef) {
          const preview = byRef.get(attachment.previewRef);
          if (!preview || preview.producer_product_turn_id !== row.productTurnId) invalid();
          referenced.add(attachment.previewRef);
        }
      }
  }
  if (referenced.size !== byRef.size) invalid();
}
