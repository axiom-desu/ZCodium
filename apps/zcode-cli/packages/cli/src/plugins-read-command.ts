import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import {
  formatAvailablePluginJson,
  formatDiagnosticJson,
  formatDiagnosticLines,
  formatHumanAvailableList,
  formatHumanPluginList,
  formatPluginJson,
  writeWarnings,
} from "./plugins-command-format.js";
import {
  baseOptions,
  hasErrors,
  resolveDep,
  type PluginsCommandDependencies,
  type PluginsCommandFlags,
} from "./plugins-command-shared.js";

// 只拆读/校验职责：输出、诊断、退出码与 DI 调用顺序保持原命令 ABI。
export async function runPluginsListCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
): Promise<number> {
  const base = baseOptions(deps);
  const outcome = await (await resolveDep(deps, "listPlugins"))(base);
  const installed = outcome.plugins.map((plugin) => formatPluginJson(plugin, outcome.diagnostics));
  if (!flags.available) {
    ctx.stdout.write(
      options.json ? formatJson(installed) : formatHumanPluginList(outcome, options),
    );
    // 市场刷新失败这类诊断的 pluginId 是市场 id 或为空，归不到任何条目；error 级不能静默丢掉。
    const knownIds = new Set(outcome.plugins.map((plugin) => plugin.id));
    const orphaned = outcome.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        !(diagnostic.pluginId && knownIds.has(diagnostic.pluginId)),
    );
    if (orphaned.length === 0) return 0;
    ctx.stderr.write(formatDiagnosticLines(orphaned));
    return 1;
  }
  const overview = await (await resolveDep(deps, "getPluginsOverview"))(base);
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        installed,
        available: overview.availablePlugins.map(formatAvailablePluginJson),
        diagnostics: [...outcome.diagnostics, ...overview.diagnostics].map(formatDiagnosticJson),
      }),
    );
    return 0;
  }
  ctx.stdout.write(
    `${formatHumanPluginList(outcome, options)}\n${formatHumanAvailableList(overview.availablePlugins)}`,
  );
  return 0;
}

export async function runPluginsValidateCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  path: string,
): Promise<number> {
  const diagnostics = await (
    await resolveDep(deps, "validatePluginPath")
  )({
    ...baseOptions(deps),
    path,
  });
  const failed = hasErrors(diagnostics);
  if (options.json) {
    ctx.stdout.write(
      formatJson({ path, ok: !failed, diagnostics: diagnostics.map(formatDiagnosticJson) }),
    );
    return failed ? 1 : 0;
  }
  if (failed) {
    ctx.stderr.write(`Plugin manifest is invalid: ${path}\n${formatDiagnosticLines(diagnostics)}`);
    return 1;
  }
  ctx.stdout.write(`Plugin manifest is valid: ${path}\n`);
  writeWarnings(ctx, diagnostics);
  return 0;
}
