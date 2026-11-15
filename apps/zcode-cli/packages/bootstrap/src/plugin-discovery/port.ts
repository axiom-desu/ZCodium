import {
  type PluginActivationStatus,
  type PluginDiscoveryCandidate,
  type PluginDiscoveryContext,
  type PluginDiscoveryPort,
  type SuggestPluginInstallOutput,
} from "@zcode/contracts";
import { isOfficialMarketplaceId } from "@zcode/contracts";
import { searchPluginCatalog } from "./search.js";

/** `pluginId` 的市场后缀必须就是官方市场；其他 id 一律 unavailable。 */
function marketplaceOf(pluginId: string): string | undefined {
  const at = pluginId.lastIndexOf("@");
  return at <= 0 || at === pluginId.length - 1 ? undefined : pluginId.slice(at + 1);
}

interface PluginDiscoveryDependencies {
  /** 候选目录投影：只读、来自既有插件 store（唯一的插件目录事实源）。 */
  list(): PluginDiscoveryCandidate[] | Promise<PluginDiscoveryCandidate[]>;
  resolve(pluginId: string): Promise<PluginDiscoveryCandidate | undefined>;
  refresh(options: { force: boolean; signal: AbortSignal }): Promise<{ stale: boolean }>;
  /** 写：安装/启用。实现方负责存储锁与复验；返回是否真的改了状态。 */
  apply(plugin: PluginDiscoveryCandidate, context: PluginDiscoveryContext): Promise<boolean>;
  /** 会话内激活事实；缺席时只能回答 refreshRequired，绝不伪报 ready。 */
  activate?(
    pluginId: string,
    context: PluginDiscoveryContext,
    changed: boolean,
  ): Promise<PluginActivationStatus>;
}

/**
 * 插件发现的用例层。**调用进入这里之前，用户确认已经发生**：本仓把
 * `SuggestPluginInstall` 的确认交给既有权限审批通道（`alwaysAsk` + 不可 allowAlways），
 * 因此这里不实现第二套卡片状态机；用户拒绝时 handler 根本不会执行。
 */
export function createPluginDiscoveryPort(deps: PluginDiscoveryDependencies): PluginDiscoveryPort {
  // 同一工具调用的重复派发复用结果；不同调用各自经过一次审批。
  const operations = new Map<string, Promise<SuggestPluginInstallOutput>>();

  async function suggest(
    input: Parameters<PluginDiscoveryPort["suggest"]>[0],
    context: PluginDiscoveryContext,
  ): Promise<SuggestPluginInstallOutput> {
    const { pluginId } = input;
    const outcome = (
      status: SuggestPluginInstallOutput["status"],
      message: string,
    ): SuggestPluginInstallOutput => ({ pluginId, status, message });
    context.signal.throwIfAborted();
    if (marketplaceOf(pluginId) === undefined || !isOfficialMarketplaceId(marketplaceOf(pluginId)!))
      return outcome("unavailable", "Plugin is not a visible official marketplace entry.");
    let plugin = await deps.resolve(pluginId);
    if (!plugin) {
      const refreshed = await deps.refresh({ force: false, signal: context.signal });
      if (refreshed.stale)
        return outcome("unavailable", "Official marketplace could not be refreshed.");
      plugin = await deps.resolve(pluginId);
    }
    if (!plugin)
      return outcome(
        "unavailable",
        "Plugin is absent from the official catalog or has conflicting identities.",
      );
    if (plugin.action === "none") {
      const activation = await activate(pluginId, context, false);
      return {
        ...outcome(
          "alreadyAvailable",
          "Plugin is installed and enabled; check activation before using it.",
        ),
        activation,
      };
    }
    // 确认期间目录、安装态或 workspace 覆盖可能变化；必须重新可信解析后才执行。
    const refreshed = await deps.refresh({ force: true, signal: context.signal });
    context.signal.throwIfAborted();
    if (refreshed.stale)
      return outcome("unavailable", "Official marketplace refresh failed. Nothing was installed.");
    const current = await deps.resolve(pluginId);
    if (!current) return outcome("unavailable", "Plugin is no longer available.");
    if (current.action !== plugin.action || current.scope !== plugin.scope)
      return outcome("unavailable", "Plugin state changed during confirmation. Request a new confirmation.");
    let changed: boolean;
    try {
      changed = await deps.apply(current, context);
    } catch (error) {
      context.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : "Plugin installation failed.";
      return outcome(message.startsWith("plugin_") ? "unavailable" : "failed", message);
    }
    const activation = await activate(pluginId, context, changed);
    return {
      ...outcome(
        !changed ? "alreadyAvailable" : current.action === "enable" ? "enabled" : "installed",
        activation === "ready"
          ? "Plugin is ready in this session."
          : activation === "disabled"
            ? "Plugin is installed but disabled in this workspace. Enabling it requires separate confirmation."
            : activation === "needsConfiguration"
              ? "Plugin is installed. Complete configuration or authorization in plugin settings."
              : changed && deps.activate
                ? "Plugin is installed. The session will reload when accepted work finishes. Do not use the new capability in this turn."
                : "Plugin is installed. Its capability has not been verified in this session.",
      ),
      activation,
    };
  }

  async function activate(
    pluginId: string,
    context: PluginDiscoveryContext,
    changed: boolean,
  ): Promise<PluginActivationStatus> {
    if (!deps.activate) return "refreshRequired";
    try {
      return await deps.activate(pluginId, context, changed);
    } catch {
      return "failed";
    }
  }

  return {
    async search(input, context) {
      context.signal.throwIfAborted();
      const { stale } = await deps.refresh({ force: false, signal: context.signal });
      return searchPluginCatalog(await deps.list(), input, stale);
    },
    suggest(input, context) {
      const key = `${context.sessionId}:${context.toolCallId}`;
      const existing = operations.get(key);
      if (existing) return existing;
      const operation = suggest(input, context);
      operations.set(key, operation);
      // 结果由既有 Session 持久化；这里只保留有限数量的重复派发结果。
      if (operations.size > 128) operations.delete(operations.keys().next().value!);
      return operation;
    },
  };
}
