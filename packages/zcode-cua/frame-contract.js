/**
 * 官方 CUA 帧契约的占位实现：真实实现随闭源 producer 一起未发布，本仓没有任何位置能产出官方帧信封。
 * 因此下列谓词恒为 false/undefined 属于**正确否定**，不是 bug；切勿改成恒 true——
 * 那会剥掉全部 MCP 文本块、伪造 attestation，并让工具结果直接抛错。
 *
 * 两个已知的潜在 fail-open（谓词失效 → 防转移失效），留待后续决策：
 * 1. apps/zcode-cli/packages/core/src/mcp/image-normalization.ts 的伪造 image_ref 剥离分支永不触发；
 * 2. apps/zcode-cli/packages/node-repl-host/src/result.ts 的 keepLatestCuaFrame 永不去重。
 *
 * 若本仓要真正支持官方 CUA，必须按 producer 发布的信封格式实现，不要在调用方猜。
 */
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";

export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

export function isOfficialCuaImageRefText(_text) {
  return false;
}

export function containsOfficialCuaImageRefCredentialText(_text) {
  return false;
}

export async function preserveOfficialCuaFrameResult(result) {
  return result;
}

export function attestOfficialCuaFrameContent(_content, _expectedKind) {
  return undefined;
}

export function findOfficialCuaFrameContentPair(_content) {
  return undefined;
}
