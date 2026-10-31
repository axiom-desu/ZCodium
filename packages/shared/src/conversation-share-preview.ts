import { CONVERSATION_ARCHIVE_LIMITS } from "./conversation-archive.js";

/**
 * 匿名公开预览响应的正文上限。
 *
 * preview 的 `data` 与离线归档 manifest 是同一份公开投影（rows + content_blocks + artifacts），
 * 因此直接沿用 manifestBytes 作为合同上限；外层 `{code,msg,data}` 信封与请求 ID 另留固定头寸。
 * 不取更小的值：本端明确支持的公开载荷必须能完整读回，不能为了“防大响应”把合法分享读坏。
 */
export const CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES =
  CONVERSATION_ARCHIVE_LIMITS.manifestBytes + 64 * 1024;
