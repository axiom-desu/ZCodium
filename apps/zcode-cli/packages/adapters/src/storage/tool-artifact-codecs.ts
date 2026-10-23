import { createHash } from "node:crypto";
import { join } from "node:path";
import { stat } from "node:fs/promises";

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function extensionForContentType(contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    default:
      return ".json";
  }
}

export function extensionForBinaryContentType(contentType: string): string {
  const extension = extensionForContentType(contentType);
  return extension === ".json" && !contentType.toLowerCase().includes("json") ? ".bin" : extension;
}

export function normalizeArtifactExtension(extension: string): string {
  const withDot = extension.startsWith(".") ? extension : `.${extension}`;
  const sanitized = withDot
    .replace(/[^a-zA-Z0-9.]/g, "")
    .slice(0, 16)
    .toLowerCase();
  return /^\.[a-z0-9]+$/.test(sanitized) ? sanitized : ".bin";
}

export function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".bin")) return "application/octet-stream";
  // dwf 产物按原扩展名落盘（`extension` 入参），推断表补齐它们。文本类给 text/*
  // （utf8 读回正确），办公文件与 svg 之外的未知二进制一律 octet-stream——**绝不**再让一个
  // 不认识的扩展名落到 application/json 走 utf8（那正是读回损坏的根因）。
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  // 文本写入的默认扩展名就是 .json（extensionForContentType 的 default），所以既有文件全部
  // 落在上面的分支里；到这里的只有按原扩展名落盘的二进制产物（.xlsx / .docx / .pptx …）。
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

export function isTextArtifactContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.startsWith("text/");
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

type DerivedMediaKind = "image" | "video" | "pdf";

export function derivedMediaAttachmentPath(
  imageCacheRootDir: string,
  pdfCacheRootDir: string,
  videoCacheRootDir: string,
  uri: string,
  mediaType: string,
): string | undefined {
  const { sessionId } = parseArtifactUri(uri);
  const kind = mediaKindForContentType(mediaType);
  const extension = extensionForDerivedMediaContentType(mediaType);
  if (!kind || !extension) return undefined;
  const cacheRootDir =
    kind === "image" ? imageCacheRootDir : kind === "video" ? videoCacheRootDir : pdfCacheRootDir;
  const uriHash = createHash("sha256").update(uri).digest("hex").slice(0, 32);
  return join(cacheRootDir, sanitizePathSegment(sessionId), `${kind}-${uriHash}${extension}`);
}

export function mediaKindForContentType(mediaType: string): DerivedMediaKind | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  return undefined;
}

function extensionForDerivedMediaContentType(mediaType: string): string | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "video/x-matroska":
      return ".mkv";
    case "video/x-m4v":
      return ".m4v";
    case "video/x-msvideo":
      return ".avi";
    case "application/pdf":
      return ".pdf";
    default:
      return undefined;
  }
}

export function decodeMediaDataUrlArtifact(
  content: string,
  uri: string,
  expectedKind: DerivedMediaKind,
): { bytes: Buffer; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = headerParts.shift()?.trim();
  if (
    mediaKindForContentType(mediaType ?? "") !== expectedKind ||
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    commaIndex < 0
  ) {
    throw new Error(`Media attachment artifact is not a base64 ${expectedKind} data URL: ${uri}`);
  }
  const bytes = Buffer.from(content.slice(commaIndex + 1), "base64");
  if (bytes.byteLength === 0) {
    throw new Error(`Media attachment artifact is empty: ${uri}`);
  }
  return { bytes, mediaType: mediaType! };
}

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function parseArtifactUri(uri: string): { artifactId: string; sessionId: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new Error(`Invalid tool artifact URI: ${uri}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (parsed.protocol !== "zcode-artifact:") {
    throw new Error(`Unsupported tool artifact URI: ${uri}`);
  }

  const sessionId = decodeURIComponent(parsed.hostname);
  const artifactId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!sessionId || !artifactId) {
    throw new Error(`Invalid tool artifact URI: ${uri}`);
  }

  return { artifactId, sessionId };
}
