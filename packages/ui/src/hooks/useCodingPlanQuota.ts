import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodingPlanQuotaSnapshot, UsageQuotaLimit } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { resolveModelProviderFamilyIdByBaseURL } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";

/**
 * Coding Plan 剩余额度：只用用户自己填写的 API Key。
 *
 * 它刻意不复用账号态：账号登录已从本仓库移除，额度查询的鉴权上游就是裸 API Key。
 * 这里不缓存快照到全局 store，也不轮询——每次打开或手动刷新才请求一次。
 */

/** 稳定的空引用：view 未就绪时每次渲染都构造 [] 会让 memo 与 effect 反复失效。 */
const NO_PROVIDERS: ProviderSettingsView["providers"] = [];

export interface CodingPlanQuotaCandidate {
  providerId: string;
  providerName: string;
  apiKey: string;
  /** 该 Provider 配置里的 API 地址，服务层据此判定 family 与网关。 */
  baseUrl: string;
}

interface CodingPlanQuotaState {
  snapshot: CodingPlanQuotaSnapshot | null;
  loading: boolean;
  error: string | null;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  return String(error);
}

/**
 * 从当前 Provider 视图里挑出可用于查额度的 Coding Plan 连接。
 *
 * 只认 `zhipu-coding-plan-api-key`：普通 `api-key` provider 也可能挂在 bigmodel 域上，
 * 但它们不保证是套餐 Key，拿去查额度会把 401 误报成"额度耗尽"。
 * 只读 Provider Settings View，UI 不维护第二份 Key 或配置副本。
 */
export function resolveCodingPlanQuotaCandidates(
  providers: ProviderSettingsView["providers"],
): CodingPlanQuotaCandidate[] {
  const candidates: CodingPlanQuotaCandidate[] = [];
  for (const provider of providers) {
    const access = provider.effectiveConfig.access;
    if (access?.type !== "zhipu-coding-plan-api-key") continue;
    const apiKey = access.apiKey?.trim() ?? "";
    if (!apiKey) continue;
    if (!resolveModelProviderFamilyIdByBaseURL(provider.effectiveConfig.api?.baseUrl)) continue;
    if (candidates.some((item) => item.providerId === provider.providerId)) continue;
    candidates.push({
      providerId: provider.providerId,
      providerName: provider.providerName ?? provider.providerId,
      apiKey,
      baseUrl: provider.effectiveConfig.api?.baseUrl ?? "",
    });
  }
  return candidates;
}

/** 是否存在"有 Coding Plan 连接但还没填 Key"的配置，用于区分引导与失败两种空态。 */
export function hasPendingCodingPlanConnection(
  providers: ProviderSettingsView["providers"],
): boolean {
  return providers.some((provider) => {
    const access = provider.effectiveConfig.access;
    return (
      access?.type === "zhipu-coding-plan-api-key" && (access.apiKey?.trim() ?? "").length === 0
    );
  });
}

export function useCodingPlanQuota() {
  const { usageStatsService } = useServices();
  const providerSettings = useProviderSettingsView();
  const view = providerSettings.state.status === "ready" ? providerSettings.state.view : null;
  const providers = view?.providers ?? NO_PROVIDERS;

  // useMemo 保持 candidates 引用稳定：否则每次渲染都产生新数组，
  // 依赖它的 effect 会无限重发请求。
  const candidates = useMemo(() => resolveCodingPlanQuotaCandidates(providers), [providers]);
  const pendingConnection = useMemo(() => hasPendingCodingPlanConnection(providers), [providers]);

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [state, setState] = useState<CodingPlanQuotaState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const requestVersionRef = useRef(0);

  const activeCandidate = useMemo(
    () =>
      candidates.find((item) => item.providerId === selectedProviderId) ?? candidates[0] ?? null,
    [candidates, selectedProviderId],
  );

  const refresh = useCallback(async () => {
    if (!activeCandidate) {
      // 没有可用 Key 时绝不发请求，也不构造空快照：空快照会被渲染成"额度已用完"。
      setState({ snapshot: null, loading: false, error: null });
      return;
    }
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setState((current) => ({ snapshot: current.snapshot, loading: true, error: null }));
    try {
      const snapshot = await usageStatsService.getCodingPlanQuota({
        providerId: activeCandidate.providerId,
        baseUrl: activeCandidate.baseUrl,
        apiKey: activeCandidate.apiKey,
      });
      if (requestVersionRef.current !== requestVersion) return;
      setState({ snapshot, loading: false, error: null });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) return;
      const message = readErrorMessage(error);
      logger.warn("[useCodingPlanQuota] 读取 Coding Plan 剩余额度失败", {
        providerId: activeCandidate.providerId,
        error: message,
      });
      // 保留上一次成功快照，同时暴露失败；清空会让用户误判成没有套餐。
      setState((current) => ({ snapshot: current.snapshot, loading: false, error: message }));
    }
  }, [activeCandidate, usageStatsService]);

  useEffect(() => {
    // candidates 与 activeCandidate 已 memo 化，refresh 只在"目标连接或 Key 变化"时换引用，
    // 因此这里既不会漏掉新增/删除连接，也不会重复打远端。
    void refresh();
  }, [refresh]);

  return {
    candidates,
    activeCandidate,
    pendingConnection,
    selectProvider: setSelectedProviderId,
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}

export type { UsageQuotaLimit };
