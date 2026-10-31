import { ZipFile } from "yazl";
import {
  CONVERSATION_ARCHIVE_LIMITS as LIMITS,
  type ConversationArchiveArtifact,
  type ConversationArchiveContent,
} from "@zcode/shared";
import { sha256ConversationShareJson } from "./conversationShareIntegrity.js";
import {
  archiveSha256,
  assertArchiveJsonBounds,
  ConversationArchiveError,
  validateArchiveManifest,
} from "./conversationArchiveValidation.js";
import { readArchiveStream, readConversationArchiveZip } from "./conversationArchiveZip.js";

export { ConversationArchiveError } from "./conversationArchiveValidation.js";

export interface ConversationArchiveInput {
  title: string;
  selectedProductTurnIds: string[];
  rows: ConversationArchiveContent["rows"];
  artifacts: Array<{ descriptor: ConversationArchiveArtifact; bytes: Uint8Array }>;
  /** 公开内容块（workflow v1/v2 与 tool-presentation v1）；缺席写出 v1 归档。 */
  contentBlocks?: Extract<ConversationArchiveContent, { version: 2 }>["content_blocks"];
}
export interface DecodedConversationArchive {
  content: ConversationArchiveContent;
  artifacts: Map<string, Buffer>;
}

function normalizeArchiveError(error: unknown): never {
  if (error instanceof ConversationArchiveError) throw error;
  throw new ConversationArchiveError("invalid_archive");
}

/** 调用方先做选择/公开投影；此边界验证内容，只生成本地可移植文件。 */
export async function encodeConversationArchive(input: ConversationArchiveInput): Promise<Buffer> {
  try {
    const content: ConversationArchiveContent =
      input.contentBlocks === undefined
        ? {
            format: "zcodium-conversation",
            version: 1,
            title: input.title,
            selectedProductTurnIds: input.selectedProductTurnIds,
            rows: input.rows,
            artifacts: input.artifacts.map(({ descriptor }) => descriptor),
          }
        : {
            format: "zcodium-conversation",
            version: 2,
            title: input.title,
            selectedProductTurnIds: input.selectedProductTurnIds,
            rows: input.rows,
            artifacts: input.artifacts.map(({ descriptor }) => descriptor),
            content_blocks: input.contentBlocks,
          };
    assertArchiveJsonBounds(content);
    const manifest = { content, sha256: sha256ConversationShareJson(content) };
    validateArchiveManifest(manifest);
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    if (manifestBytes.length > LIMITS.manifestBytes)
      throw new ConversationArchiveError("limit_exceeded");
    // 写入前复制并验证完整快照，不能一边压缩一边继续读取可变的源缓冲区。
    const blobs = new Map<string, Buffer>();
    for (const { descriptor, bytes } of input.artifacts) {
      if (bytes.byteLength !== descriptor.size_bytes)
        throw new ConversationArchiveError("integrity_mismatch");
      const copied = Buffer.from(bytes);
      if (archiveSha256(copied) !== descriptor.sha256)
        throw new ConversationArchiveError("integrity_mismatch");
      blobs.set(descriptor.sha256, copied);
    }
    const zip = new ZipFile();
    const result = readArchiveStream(zip.outputStream, LIMITS.archiveBytes);
    zip.on("error", () =>
      zip.outputStream.destroy(new ConversationArchiveError("invalid_archive")),
    );
    zip.addBuffer(manifestBytes, "manifest.json");
    for (const [sha256, bytes] of blobs) zip.addBuffer(bytes, `blobs/${sha256}`);
    zip.end();
    return await result;
  } catch (error) {
    return normalizeArchiveError(error);
  }
}

/** 全部校验通过才交付；不执行、不下载、不按归档中的路径写文件。 */
export async function decodeConversationArchive(
  bytes: Uint8Array,
): Promise<DecodedConversationArchive> {
  try {
    const entries = await readConversationArchiveZip(bytes);
    const manifest = entries.get("manifest.json");
    if (!manifest) throw new ConversationArchiveError("invalid_archive");
    const content = validateArchiveManifest(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(manifest)),
    );
    const artifacts = new Map<string, Buffer>();
    const used = new Set(["manifest.json"]);
    for (const artifact of content.artifacts) {
      const name = `blobs/${artifact.sha256}`;
      const value = entries.get(name);
      if (
        !value ||
        value.length !== artifact.size_bytes ||
        archiveSha256(value) !== artifact.sha256
      ) {
        throw new ConversationArchiveError("integrity_mismatch");
      }
      artifacts.set(artifact.artifact_id, value);
      used.add(name);
    }
    if (used.size !== entries.size) throw new ConversationArchiveError("invalid_archive");
    return { content, artifacts };
  } catch (error) {
    return normalizeArchiveError(error);
  }
}
