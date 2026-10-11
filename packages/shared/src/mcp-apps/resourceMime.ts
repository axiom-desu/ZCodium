/**
 * 页面发起的 `resources/read`（`mcp/uiReadResource`）单次结果总大小上限，以及 mimeType 白名单。
 * 白名单项以 `/` 结尾表示前缀匹配（如 `text/`），否则精确匹配（忽略参数与大小写）。
 *
 * 单独成文件的原因与上游一致：契约文件有行数上限，而这张白名单会随支持的资源类型增长。
 */

export const MCP_APPS_UI_READ_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;

// 修复：原白名单只有 7 项，遗漏 PDF 与常见办公/图片/音视频资源，插件已握手却读不到文件。
// 按明确 MIME 补齐（未知类型仍然拒绝，不能靠 `application/*` 之类的宽匹配放行）。
export const MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST: readonly string[] = [
  "text/",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  // 文档与办公文件。
  "application/pdf",
  "application/rtf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // 图片。
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/heic",
  "image/heif",
  // 音视频。
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/mpeg",
  // 归档、字体与模型只传输内容，由插件决定如何使用。
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  "model/gltf+json",
  "model/gltf-binary",
  "application/octet-stream",
];

export function isMcpAppsUiReadResourceMimeAllowed(mimeType: string): boolean {
  const essence = mimeType.split(";")[0]!.trim().toLowerCase();
  if (!essence) return false;
  return MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST.some((entry) =>
    entry.endsWith("/") ? essence.startsWith(entry) : essence === entry,
  );
}
