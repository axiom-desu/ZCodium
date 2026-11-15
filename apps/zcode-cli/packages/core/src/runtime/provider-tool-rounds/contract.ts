/**
 * Provider 内置工具轮次的公开入口（上游 3.18.2 F11「Provider 内置工具多轮回放」）。
 * 流中切轮与卡片只由 runModelTextRequest 调用；回放 entries 由成功/取消提交路径生成；
 * 冷恢复用 isProviderExecutedToolPartMetadata 识别轮次边界。
 * 同一条持久化 assistant 拆出的 entry 用 withCompactGroupKey 打分组键，compact 才与持久化边界一致。
 */
export {
  createProviderToolRoundEntries,
  hasProviderToolRoundContent,
  isProviderExecutedToolPartMetadata,
  providerToolRoundsCompactGroupKey,
} from "./rounds.js";
export type { ProviderToolRound } from "./rounds.js";
