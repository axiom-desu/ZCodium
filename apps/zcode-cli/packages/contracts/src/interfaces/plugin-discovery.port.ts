import type {
  PluginActivationStatus,
  SearchPluginsInput,
  SearchPluginsOutput,
  SuggestPluginInstallInput,
  SuggestPluginInstallOutput,
} from "../tools/plugin-discovery.js";

/**
 * 发现工具的可信上下文。只由 Core 执行上下文构造：工具 JSON 里没有会话身份，
 * 端口也不能从输入反推。
 */
export interface PluginDiscoveryContext {
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  traceId: string;
  signal: AbortSignal;
}

/**
 * 插件发现的唯一所有者：候选目录来自既有插件 store，安装/启用意图也写回同一 store。
 *
 * `search` 只读目录（允许过期结果 + `stale` 标记）；`suggest` 是写意图，调用方必须在
 * 用户显式确认之后才进来——本仓把该确认交给既有权限审批通道，不另设卡片状态机。
 */
export interface PluginDiscoveryPort {
  search(input: SearchPluginsInput, context: PluginDiscoveryContext): Promise<SearchPluginsOutput>;
  suggest(
    input: SuggestPluginInstallInput,
    context: PluginDiscoveryContext,
  ): Promise<SuggestPluginInstallOutput>;
}

/**
 * 会话刷新由独立实现接入；没有注入时不能把安装完成当作工具已可用（必须回答
 * `refreshRequired`，绝不伪报 ready）。
 */
export interface PluginActivationPort {
  activate(
    input: {
      sessionId: string;
      pluginId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
    },
    context: PluginDiscoveryContext,
  ): Promise<PluginActivationStatus>;
}
