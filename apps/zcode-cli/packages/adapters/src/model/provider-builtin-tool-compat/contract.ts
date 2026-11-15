/**
 * Provider 内置工具线协议兼容的公开入口（上游 3.18.2 F11）。
 * 只由 anthropic-stream-compat 在 Anthropic fetch 边界调用。
 */
export {
  ProviderBuiltinToolStreamRewriter,
  rewriteProviderBuiltinToolContent,
} from "./compat.js";
export type { SseFrame } from "./compat.js";
