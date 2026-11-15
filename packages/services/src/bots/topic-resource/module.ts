/**
 * bot-topic-resource 模块清单（architecture-governance managed 模块）。
 * 层：adapters（真实磁盘归档与 provider 下载集成）。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const botTopicResourceModule = {
  id: "bot-topic-resource",
  requires: ["shared", "services"],
  provides: ["bot-topic-resource"],
  publicEntrypoints: ["../../bots/topicResource.ts", "../../bots/topicArchive.ts", "contract.ts"],
} as const;
