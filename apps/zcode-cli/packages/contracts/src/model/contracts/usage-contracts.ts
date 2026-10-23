import type { ModelServerToolUsage } from "./tool-contracts.js";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  serverToolUse?: ModelServerToolUsage;
}

export interface ModelUsageSummary {
  source: "provider";
  modelRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
}

export function getModelUsageTotalTokens(usage?: ModelUsage): number {
  if (!usage) return 0;
  const inputTokens =
    usage.inputTokens ?? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return usage.totalTokens ?? inputTokens + (usage.outputTokens ?? 0);
}

export function getModelUsageContextTokens(usage?: ModelUsage): number | undefined {
  if (!usage) return undefined;

  const inputTokens = getModelUsageInputWindowTokens(usage);
  const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
  const contextTokens = (inputTokens ?? 0) + outputTokens;
  if (contextTokens > 0) {
    return contextTokens;
  }

  const totalTokens = positiveInteger(usage.totalTokens);
  return totalTokens;
}

export function getModelUsageInputWindowTokens(usage?: ModelUsage): number | undefined {
  if (!usage) return undefined;

  const inputTokens = positiveInteger(usage.inputTokens);
  if (inputTokens !== undefined) {
    // AI SDK v6 的 Anthropic inputTokens 已经是普通输入 + cache read/write 的 total input。
    // 这里再叠 cacheReadTokens 会把 context meter 和 compact 阈值放大一截。
    return inputTokens;
  }

  const totalTokens = positiveInteger(usage.totalTokens);
  if (totalTokens !== undefined) {
    const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
    return Math.max(0, totalTokens - outputTokens);
  }

  const cacheTokens =
    (nonNegativeInteger(usage.cacheReadTokens) ?? 0) +
    (nonNegativeInteger(usage.cacheWriteTokens) ?? 0);
  return cacheTokens > 0 ? cacheTokens : undefined;
}

export function hasModelUsage(usage?: ModelUsage): boolean {
  if (!usage) return false;
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.serverToolUse?.webSearchRequests !== undefined ||
    usage.serverToolUse?.webFetchRequests !== undefined
  );
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

export function createModelUsageSummary(
  usages: readonly ModelUsage[],
): ModelUsageSummary | undefined {
  const realUsages = usages.filter(hasModelUsage);
  if (realUsages.length === 0) return undefined;

  return realUsages.reduce<ModelUsageSummary>(
    (summary, usage) => ({
      source: "provider",
      modelRequestCount: summary.modelRequestCount + 1,
      inputTokens: summary.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: summary.outputTokens + (usage.outputTokens ?? 0),
      totalTokens: summary.totalTokens + getModelUsageTotalTokens(usage),
      cacheReadTokens: summary.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: summary.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      reasoningTokens: summary.reasoningTokens + (usage.reasoningTokens ?? 0),
      webFetchRequests: summary.webFetchRequests + (usage.serverToolUse?.webFetchRequests ?? 0),
      webSearchRequests: summary.webSearchRequests + (usage.serverToolUse?.webSearchRequests ?? 0),
    }),
    {
      source: "provider",
      modelRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webFetchRequests: 0,
      webSearchRequests: 0,
    },
  );
}
