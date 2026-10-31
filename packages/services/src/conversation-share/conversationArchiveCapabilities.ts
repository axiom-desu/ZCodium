import { CONVERSATION_ARCHIVE_LIMITS, type ConversationShareCapabilities } from "@zcode/shared";

/** 文件格式能力随应用分发，预检不需要官方账号或网络。 */
export function conversationArchiveCapabilities(): ConversationShareCapabilities {
  return {
    schema_version: 1,
    // 归档 v2 及其公开内容块随同一应用版本分发：本端能写就能读。
    content_block_versions: { workflow: 2, "tool-presentation": 1 },
    access_modes: ["private"],
    max_rows: CONVERSATION_ARCHIVE_LIMITS.rows,
    max_payload_bytes: CONVERSATION_ARCHIVE_LIMITS.manifestBytes,
    max_artifact_count: CONVERSATION_ARCHIVE_LIMITS.artifacts,
    max_artifact_bytes: CONVERSATION_ARCHIVE_LIMITS.artifactBytes,
    max_total_artifact_bytes: CONVERSATION_ARCHIVE_LIMITS.totalArtifactBytes,
    allowed_artifacts: [
      { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
      {
        type: "docx",
        extensions: ["docx"],
        mime_types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      },
      {
        type: "xlsx",
        extensions: ["xlsx"],
        mime_types: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      },
      {
        type: "pptx",
        extensions: ["pptx"],
        mime_types: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      },
      {
        type: "image",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        mime_types: [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "image/bmp",
          "image/svg+xml",
        ],
      },
      { type: "html", extensions: ["html", "htm"], mime_types: ["text/html"] },
      { type: "md", extensions: ["md", "markdown"], mime_types: ["text/markdown", "text/plain"] },
      {
        type: "text",
        extensions: ["txt", "csv", "json", "log"],
        mime_types: ["text/plain", "text/csv", "application/json"],
      },
    ],
  };
}
