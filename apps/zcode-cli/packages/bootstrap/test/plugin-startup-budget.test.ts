import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Logger, PluginLoadOutcome } from "@zcode/contracts";
import { createConfig } from "@zcode/adapters/config";
import { createPluginStartupBudget } from "../src/plugin-startup-budget/index.js";
import { resolveStartupPlugins } from "../src/app/startup-marks.js";
import { StartupTimer } from "../src/startup-logging.js";

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

function pluginOutcome(name: string): PluginLoadOutcome {
  return {
    commandRoots: [],
    diagnostics: [],
    hooks: {},
    mcpServers: {},
    plugins: [
      {
        name,
        version: "1.0.0",
        rootPath: `/tmp/${name}`,
      } as PluginLoadOutcome["plugins"][number],
    ],
    skillRoots: [],
  };
}

it("times out into a warning fallback and discards the late completion", async () => {
  let timeouts = 0;
  const budget = createPluginStartupBudget({
    timeoutMs: 10,
    onTimeout: () => {
      timeouts += 1;
    },
  });
  const late = Promise.withResolvers<PluginLoadOutcome>();
  const result = await budget.resolvePlugins(() => late.promise);
  assert.equal(budget.degraded, true);
  assert.equal(timeouts, 1);
  assert.equal(result.plugins.length, 0);
  assert.equal(result.diagnostics[0]?.code, "plugin_startup_timeout");
  late.resolve(pluginOutcome("late-plugin"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 迟到结果不能替换已返回的降级结果。
  assert.equal((await budget.resolvePlugins(async () => pluginOutcome("ignored"))).plugins.length, 0);
});

it("concurrent resolves share one deadline and one timeout event", async () => {
  let timeouts = 0;
  const budget = createPluginStartupBudget({
    timeoutMs: 10,
    onTimeout: () => {
      timeouts += 1;
    },
  });
  const gate = Promise.withResolvers<void>();
  const resolver = async () => {
    await gate.promise;
    return pluginOutcome("slow");
  };
  const [first, second] = await Promise.all([
    budget.resolvePlugins(resolver),
    budget.resolvePlugins(resolver),
  ]);
  gate.resolve();
  assert.equal(timeouts, 1);
  assert.equal(first.diagnostics[0]?.code, "plugin_startup_timeout");
  assert.equal(second.diagnostics[0]?.code, "plugin_startup_timeout");
});

it("late rejection after timeout is consumed, not surfaced as unhandled", async () => {
  const budget = createPluginStartupBudget({ timeoutMs: 5, onTimeout: () => undefined });
  const late = Promise.withResolvers<PluginLoadOutcome>();
  const result = await budget.resolvePlugins(() => late.promise);
  assert.equal(result.diagnostics[0]?.code, "plugin_startup_timeout");
  late.reject(new Error("late failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it("dispose settles pending resolves with the close reason", async () => {
  const budget = createPluginStartupBudget({ timeoutMs: 60_000, onTimeout: () => undefined });
  const pending = budget.resolvePlugins(() => new Promise<PluginLoadOutcome>(() => undefined));
  await Promise.resolve();
  budget.dispose(new Error("process closed"));
  await assert.rejects(pending, /process closed/);
  await assert.rejects(budget.resolvePlugins(async () => pluginOutcome("after-close")), /process closed/);
});

it("resolveStartupPlugins degrades through the real budget wiring", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-plugin-budget-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const warnings: string[] = [];
  const logger: Logger = {
    ...noopLogger,
    warn: (message) => {
      warnings.push(message);
    },
  };
  const startupTimer = new StartupTimer(logger, { module: "test" }, performance.now());
  const configResult = createConfig({
    env: {},
    userConfigPath: join(root, "user.json"),
    workingDirectory: root,
  });
  const outcome = await resolveStartupPlugins({
    cliStorageRoot: root,
    configResult,
    env: {},
    logger,
    options: {
      officialPluginRoots: [],
      pluginStartupTimeoutMs: 5,
      pluginStorageRoot: join(root, "plugins"),
    },
    startupTimer,
    workingDirectory: root,
    discover: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return pluginOutcome("late-plugin");
    },
  });
  assert.equal(outcome.plugins.length, 0);
  assert.equal(outcome.diagnostics[0]?.code, "plugin_startup_timeout");
  assert.ok(warnings.some((message) => /budget exhausted/i.test(message)));
});
