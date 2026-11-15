import type { ConfigResult } from "@zcode/adapters/config";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger, McpServerConfig, PluginLoadOutcome } from "@zcode/contracts";
import type { StartupTimer } from "../startup-logging.js";
import { resolveOfficialPluginRoots } from "./bundled-plugins.js";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "./official-plugin-definitions.js";
import { getPluginStorageRoot } from "./paths.js";
import type { ZCodeAppOptions } from "./types.js";
import { createPluginStartupBudget } from "../plugin-startup-budget/index.js";

// 以官方 startup-budget 的降级模型为准；冷启动默认封顶 30s，便于宿主按场景缩短但不禁用。
const DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS = 30_000;

export async function resolveStartupPlugins(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  options: Pick<ZCodeAppOptions, "officialPluginRoots" | "pluginStorageRoot"> &
    Pick<ZCodeAppOptions, "pluginStartupTimeoutMs">;
  startupTimer: StartupTimer;
  workingDirectory: string;
  /** 仅供测试注入慢/失败 discovery；生产缺省走同步 discovery。 */
  discover?: (
    request: Parameters<typeof discoverNodePluginsSync>[0],
  ) => PluginLoadOutcome | Promise<PluginLoadOutcome>;
}): Promise<PluginLoadOutcome> {
  const pluginStorageRoot =
    input.options.pluginStorageRoot ?? getPluginStorageRoot(input.cliStorageRoot);
  const discover = input.discover ?? discoverNodePluginsSync;
  const resolvePlugins = async (): Promise<PluginLoadOutcome> => {
    const officialPluginRoots = await resolveOfficialPluginRoots({
      extraRoots: input.options.officialPluginRoots,
      logger: input.logger,
      storageRoot: pluginStorageRoot,
      suppressedBuiltins: new Set(input.configResult.config.plugins.suppressedBuiltins),
    });
    // 预算只覆盖插件根解析 + discovery；超时降级不能把 seed/发现失败伪装成无插件。
    return await discover({
      config: input.configResult.config.plugins,
      env: input.env ?? process.env,
      officialPluginRoots,
      // defaultEnabled 的 official plugin (如 skill-creator) 只有在这里
      // 把名单传给 discoverNodePluginsSync 才会真正默认开启。CLI 子命令路径
      // (resolveZCodePlugins) 和应用启动路径都要传，否则 `/skill skill-creator` 在会话里
      // 报 "Skill not found: skill-creator"，但 `zcode plugins list` 却显示它是 enabled。
      officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
      storageRoot: pluginStorageRoot,
      workingDirectory: input.workingDirectory,
    });
  };
  const timeoutMs = input.options.pluginStartupTimeoutMs ?? DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS;
  let startupDegraded = false;
  let pluginOutcome: PluginLoadOutcome;
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    const budget = createPluginStartupBudget({
      timeoutMs,
      onTimeout(reason) {
        startupDegraded = true;
        input.logger?.warn("Plugin startup budget exhausted; plugins degraded", {
          error: reason.message,
          event: "bootstrap.app.startup.plugins.degraded",
          module: "bootstrap.app",
          timeoutMs,
        });
      },
    });
    pluginOutcome = await budget.resolvePlugins(resolvePlugins);
  } else {
    pluginOutcome = await resolvePlugins();
  }
  input.startupTimer.mark("ZCode plugins resolved", {
    context: {
      commandRootCount: pluginOutcome.commandRoots.length,
      diagnosticCount: pluginOutcome.diagnostics.length,
      enabledPluginCount: pluginOutcome.plugins.filter((plugin) => plugin.enabled).length,
      hookCount: Object.values(pluginOutcome.hooks ?? {}).reduce(
        (sum, matchers) =>
          sum + (matchers ?? []).reduce((inner, matcher) => inner + matcher.hooks.length, 0),
        0,
      ),
      mcpServerCount: Object.keys(pluginOutcome.mcpServers).length,
      pluginCount: pluginOutcome.plugins.length,
      pluginStorageRoot,
      skillRootCount: pluginOutcome.skillRoots.length,
      startupDegraded,
    },
    event: "bootstrap.app.startup.plugins.completed",
    stage: "resolve_plugins",
  });
  return pluginOutcome;
}

export function startAppStartup(input: {
  hasInjectedModelAdapter: boolean;
  resume: boolean;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.start("ZCode app startup started", {
    context: {
      hasInjectedModelAdapter: input.hasInjectedModelAdapter,
      resume: input.resume,
    },
    event: "bootstrap.app.startup.started",
    stage: "start",
  });
}

export function markConfigurationLoaded(input: {
  configResult: ConfigResult;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.mark("ZCode app configuration loaded", {
    context: {
      configSourceEnv: input.configResult.sources.env,
      configSourceProject: input.configResult.sources.project.loaded,
      configSourceUser: input.configResult.sources.user.loaded,
    },
    event: "bootstrap.app.startup.config.completed",
    stage: "load_config",
  });
}

export function markStorageAdaptersInitialized(input: {
  cliStorageRoot: string;
  hasInjectedArtifactStore: boolean;
  hasInjectedSessionStore: boolean;
  startupTimer: StartupTimer;
  storageRoot: string;
}): void {
  input.startupTimer.mark("ZCode storage adapters initialized", {
    context: {
      hasInjectedArtifactStore: input.hasInjectedArtifactStore,
      hasInjectedSessionStore: input.hasInjectedSessionStore,
      cliStorageRoot: input.cliStorageRoot,
      storageRoot: input.storageRoot,
    },
    event: "bootstrap.app.startup.storage.completed",
    stage: "initialize_storage",
  });
}

export function markMcpAdapterInitialized(input: {
  configuredMcpServers: Record<string, McpServerConfig>;
  hasInjectedMcpPort: boolean;
  mcpEnabled: boolean;
  startupTimer: StartupTimer;
  trustedMcpServerCount: number;
}): void {
  input.startupTimer.mark("ZCode MCP adapter initialized", {
    context: {
      hasInjectedMcpPort: input.hasInjectedMcpPort,
      mcpEnabled: input.mcpEnabled,
      mcpServerCount: Object.keys(input.configuredMcpServers).length,
      trustedMcpServerCount: input.trustedMcpServerCount,
    },
    event: "bootstrap.app.startup.mcp.completed",
    stage: "initialize_mcp",
  });
}

export function markRuntimeConstructed(input: {
  hasInjectedModelAdapter: boolean;
  sessionId: string;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.mark("ZCode runtime constructed", {
    context: {
      hasInjectedModelAdapter: input.hasInjectedModelAdapter,
      sessionId: input.sessionId,
    },
    event: "bootstrap.app.startup.runtime.completed",
    stage: "create_runtime",
  });
}

export function completeAppStartup(input: {
  sessionId: string;
  startupTimer: StartupTimer;
  workingDirectory: string;
}): void {
  input.startupTimer.complete("ZCode app startup completed", {
    context: {
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
    },
    event: "bootstrap.app.startup.completed",
    stage: "total",
  });
}

export function debugRuntimeConfigResolved(input: {
  configResult: ConfigResult;
  logger: Logger;
  runtimeConfig: AgentRuntimeConfig;
}): void {
  input.logger.debug("Runtime config resolved", {
    mode: input.runtimeConfig.mode,
    module: "bootstrap",
    permissionAllowedToolCount: input.configResult.config.permission.allowedTools.length,
    permissionDisallowedToolCount: input.configResult.config.permission.disallowedTools.length,
    permissionSourceEnv: input.configResult.sources.env,
    permissionSourceUserConfig: input.configResult.sources.user.loaded,
  });
}
