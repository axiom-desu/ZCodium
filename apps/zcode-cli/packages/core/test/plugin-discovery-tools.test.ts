import assert from "node:assert/strict";
import test from "node:test";
import {
  SEARCH_PLUGINS_TOOL_NAME,
  SUGGEST_PLUGIN_INSTALL_TOOL_NAME,
  type PluginDiscoveryContext,
  type PluginDiscoveryPort,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import {
  PLUGIN_DISCOVERY_TOOL_NAMES,
  searchPluginsToolEntry,
  suggestPluginInstallToolEntry,
} from "../src/tool/handlers/plugin-discovery.js";

const WORKSPACE = "/workspace/a";

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: "tool-call-1",
    traceId: "trace-1",
    turnId: "turn-1" as ToolExecutionContext["turnId"],
    abortSignal: new AbortController().signal,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    sessionId: "sess_root" as ToolExecutionContext["sessionId"],
    ...overrides,
  };
}

function fakePort(received: unknown[]): PluginDiscoveryPort {
  return {
    async search(input, ctx: PluginDiscoveryContext) {
      received.push({ method: "search", input, context: ctx });
      return { plugins: [], stale: false };
    },
    async suggest(input, ctx: PluginDiscoveryContext) {
      received.push({ method: "suggest", input, context: ctx });
      return {
        pluginId: input.pluginId,
        status: "installed",
        activation: "refreshRequired",
        message: "installed",
      };
    },
  };
}

function registered(includePluginDiscovery?: boolean): string[] {
  const names: string[] = [];
  registerBuiltInTools(
    { register: (entry: ToolEntry) => names.push(entry.metadata.name) },
    { includePluginDiscovery },
  );
  return names;
}

test("both plugin discovery tools are gated by the port being present", () => {
  assert.deepEqual([...PLUGIN_DISCOVERY_TOOL_NAMES].sort(), [
    SEARCH_PLUGINS_TOOL_NAME,
    SUGGEST_PLUGIN_INSTALL_TOOL_NAME,
  ].sort());
  const without = registered();
  assert.equal(without.includes(SEARCH_PLUGINS_TOOL_NAME), false);
  assert.equal(without.includes(SUGGEST_PLUGIN_INSTALL_TOOL_NAME), false);
  const withPort = registered(true);
  assert.equal(withPort.includes(SEARCH_PLUGINS_TOOL_NAME), true);
  assert.equal(withPort.includes(SUGGEST_PLUGIN_INSTALL_TOOL_NAME), true);
});

test("SearchPlugins is read-only, concurrent-safe and carries no approval", () => {
  assert.equal(searchPluginsToolEntry.metadata.readOnly, true);
  assert.equal(searchPluginsToolEntry.metadata.concurrentSafe, true);
  assert.equal(searchPluginsToolEntry.metadata.needsApproval, false);
  assert.equal(searchPluginsToolEntry.permission?.permission, "plugins.search");
  assert.equal(searchPluginsToolEntry.permission?.needsApproval, false);
});

test("SuggestPluginInstall always asks and cannot be remembered", () => {
  // 安装是一次性决定：记住「始终允许」等于永久免确认安装后续任何插件。
  assert.equal(suggestPluginInstallToolEntry.metadata.needsApproval, true);
  assert.equal(suggestPluginInstallToolEntry.permission?.alwaysAsk, true);
  assert.deepEqual(suggestPluginInstallToolEntry.permission?.askOptions, { allowAlways: false });
  assert.equal(suggestPluginInstallToolEntry.metadata.concurrentSafe, false);
});

test("handlers pass the trusted context, not model input, to the port", async () => {
  const received: unknown[] = [];
  const port = fakePort(received);
  const toolContext = context({ pluginDiscoveryPort: port });

  await searchPluginsToolEntry.handler(
    { query: "  email  " },
    toolContext,
  );
  const search = received[0] as { method: string; input: { query: string }; context: PluginDiscoveryContext };
  assert.equal(search.method, "search");
  assert.equal(search.input.query, "email");
  assert.equal(search.context.sessionId, "sess_root");
  assert.equal(search.context.turnId, "turn-1");
  assert.equal(search.context.toolCallId, "tool-call-1");
  assert.equal(search.context.signal, toolContext.abortSignal);

  const result = await suggestPluginInstallToolEntry.handler(
    { pluginId: "documents@zcode-plugins-official", reason: "render docx" },
    toolContext,
  );
  assert.equal((result as { status: string }).status, "installed");
  const suggest = received[1] as { method: string; input: Record<string, unknown> };
  assert.equal(suggest.method, "suggest");
  // 模型不提供会话身份，端口上下文里也没有可伪造的字段。
  assert.deepEqual(Object.keys(suggest.input).sort(), ["pluginId", "reason"]);
});

test("subagent execution fails closed even when a port is injected", async () => {
  const received: unknown[] = [];
  const toolContext = context({ pluginDiscoveryPort: fakePort(received), runtimeScope: "subagent" });
  await assert.rejects(
    async () => searchPluginsToolEntry.handler({ query: "documents" }, toolContext),
    /unavailable in this client/i,
  );
  await assert.rejects(
    async () =>
      suggestPluginInstallToolEntry.handler(
        { pluginId: "documents@zcode-plugins-official", reason: "x" },
        toolContext,
      ),
    /unavailable in this client/i,
  );
  assert.deepEqual(received, [], "fail-closed paths must not reach the plugin store");
});

test("missing port is a configuration failure, not an empty catalog", async () => {
  await assert.rejects(
    async () => searchPluginsToolEntry.handler({ query: "documents" }, context()),
    /unavailable in this client/i,
  );
});

test("invalid input is rejected before the port is reached", async () => {
  const received: unknown[] = [];
  const toolContext = context({ pluginDiscoveryPort: fakePort(received) });
  await assert.rejects(
    async () => searchPluginsToolEntry.handler({ query: "   " }, toolContext),
    /too small|at least 1/i,
  );
  await assert.rejects(
    async () =>
      suggestPluginInstallToolEntry.handler(
        { pluginId: "documents@zcode-plugins-official", reason: "x", sessionId: "sess_x" },
        toolContext,
      ),
    /unrecognized|Unrecognized/i,
  );
  assert.deepEqual(received, []);
});
