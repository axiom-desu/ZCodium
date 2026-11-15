import { useEffect, useMemo, useRef, useState } from "react";
import type { ZCodePluginMentionItem } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface PluginMentionTarget {
  pluginId: string;
  /** 插件 MCP server 上的原始工具名（不是模型可见的 `mcp__…` 名）。 */
  tool: string;
}

interface PluginMentionItemsState {
  items: ZCodePluginMentionItem[];
  loading: boolean;
  error: string | null;
  /** 旧 CLI 没有 `plugins/mentionItems`：调用方隐藏这一组，不显示为错误。 */
  supported: boolean;
}

const EMPTY_STATE: PluginMentionItemsState = {
  items: [],
  loading: false,
  error: null,
  supported: true,
};

interface ScopedState {
  scope: object | null;
  value: PluginMentionItemsState;
}

const EMPTY_SCOPED: ScopedState = { scope: null, value: EMPTY_STATE };

/**
 * `@` 面板 Plugin tool 条目的候选读取（`plugins/mentionItems`）。
 *
 * - 每次查询带递增 seq，只采用最新响应（Renderer 只保留最新一次）。
 * - target 来自扩展静态表；本 hook 不自己发现插件工具，也不把 catalog 当工具目录。
 * - 没有会话/没有 target 时不发请求；旧 CLI 的 `supported:false` 只隐藏该组。
 */
export function usePluginMentionItems(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  targets: readonly PluginMentionTarget[];
  query: string;
  enabled: boolean;
}): PluginMentionItemsState {
  const { workspacePath, workspaceIdentity, sessionId, targets, query, enabled } = params;
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;
  const [state, setState] = useState<ScopedState>(EMPTY_SCOPED);
  const seqRef = useRef(0);
  const targetKey = useMemo(
    () => targets.map((target) => `${target.pluginId}\u0000${target.tool}`).join("\u0001"),
    [targets],
  );
  // 目标/查询/会话/runtime 任变化都产生新的请求身份；旧响应不得回填到新面板。
  const requestScope = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 身份由下方值共同决定
    [workspacePath, workspaceIdentity, sessionId, targetKey, query, enabled, rpcReady, services],
  );
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;

  useEffect(() => {
    if (!enabled || !sessionId || !workspacePath || !rpcReady || targets.length === 0) return;
    const seq = ++seqRef.current;
    let cancelled = false;
    setState({ scope: requestScope, value: { ...EMPTY_STATE, loading: true } });
    const run = async () => {
      const collected: ZCodePluginMentionItem[] = [];
      let supported = false;
      for (const target of targets) {
        const result = await services.zcodeAgentService.getPluginMentionItems({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          sessionId,
          pluginId: target.pluginId,
          tool: target.tool,
          query,
        });
        if (cancelled || seq !== seqRef.current) return;
        if (!result.supported) continue;
        supported = true;
        collected.push(...result.items);
      }
      setState({
        scope: requestScope,
        value: { items: collected, loading: false, error: null, supported },
      });
    };
    run().catch((error: unknown) => {
      if (cancelled || seq !== seqRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[usePluginMentionItems] 拉取 Plugin mention items 失败", {
        error: message,
        workspaceKey,
        sessionId,
      });
      setState({
        scope: requestScope,
        value: { items: [], loading: false, error: message, supported: true },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    query,
    requestScope,
    rpcReady,
    services,
    sessionId,
    targetKey,
    targets,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
  ]);

  if (!enabled || !sessionId || targets.length === 0 || state.scope !== requestScope)
    return EMPTY_STATE;
  return state.value;
}
