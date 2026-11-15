import assert from "node:assert/strict";
import test from "node:test";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import {
  ZCODE_PLUGIN_MENTION_ERROR_CODES,
  zcodePluginMentionItemsSchema,
  zcodePluginsMentionItemsParamsSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import { getPluginMentionItems } from "../src/zcode-protocol/plugin-mention-items.js";
import { dispatchLegacyRequest } from "../src/zcode-protocol/server-dispatch-legacy.js";
import type { ProtocolRequestDispatchHost } from "../src/zcode-protocol/server-dispatch-types.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

const SESSION_ID = "sess_mention_1";
const PLUGIN_ID = "mention-plugin@zcode-plugins-official";

interface FakeApp {
  catalog: {
    plugins: Array<{
      pluginId: string;
      name: string;
      marketplace: string;
      enabled: boolean;
      conflictingPluginIds: string[];
      skillQualifiedNames: string[];
      mcpServerNames: string[];
      subagentNames: string[];
    }>;
  };
  visibility: Record<string, readonly ("model" | "app")[] | null>;
  calls: Array<{ serverName: string; tool: string; args: unknown }>;
  result?: unknown;
  error?: unknown;
}

function createContext(app: FakeApp): ZCodeProtocolAgentServerContext {
  const record = {
    app: {
      getPluginReferenceCatalog: () => app.catalog,
      getMcpToolVisibility: async (serverName: string, tool: string) =>
        app.visibility[`${serverName}/${tool}`] ?? null,
      callMcpToolForUi: async (
        serverName: string,
        tool: string,
        args: Record<string, unknown> | undefined,
      ) => {
        app.calls.push({ serverName, tool, args });
        if (app.error) throw app.error;
        return app.result;
      },
    },
  } as unknown as ZCodeProtocolSessionRecord;
  return {
    sessions: new Map([[SESSION_ID, record]]),
    deps: {},
  } as unknown as ZCodeProtocolAgentServerContext;
}

function appWith(overrides: Partial<FakeApp> = {}): FakeApp {
  return {
    catalog: {
      plugins: [
        {
          pluginId: PLUGIN_ID,
          name: "mention-plugin",
          marketplace: "zcode-plugins-official",
          enabled: true,
          conflictingPluginIds: [],
          skillQualifiedNames: [],
          mcpServerNames: ["plugin:mention-plugin:search"],
          subagentNames: [],
        },
      ],
    },
    visibility: { "plugin:mention-plugin:search/mention_search": ["model", "app"] },
    calls: [],
    ...overrides,
  };
}

function params(patch: Record<string, unknown> = {}) {
  return { sessionId: SESSION_ID, pluginId: PLUGIN_ID, tool: "mention_search", query: "", ...patch };
}

function errorCode(error: unknown): string | number | undefined {
  assert.ok(error instanceof ProtocolRequestError);
  const data = error.data;
  return typeof data === "object" && data !== null && "code" in data
    ? (data as { code?: string }).code
    : error.code;
}

test("mentionItems 经真实方法分发器往返（路由 → schema → handler → 结果）", async () => {
  const app = appWith({
    result: { structuredContent: { items: [{ id: "a", label: "A", insertText: "@a" }] } },
  });
  const host = { context: createContext(app) } as unknown as ProtocolRequestDispatchHost;
  const result = await dispatchLegacyRequest(host, {
    id: 1,
    method: zcodeProtocolMethods.pluginsMentionItems,
    params: params(),
  });
  assert.deepEqual(result, { items: [{ id: "a", label: "A", insertText: "@a" }] });
  assert.deepEqual(app.calls, [
    {
      serverName: "plugin:mention-plugin:search",
      tool: "mention_search",
      args: { query: "" },
    },
  ]);
});

test("mentionItems params and result schemas are strict and bounded", () => {
  assert.equal(zcodePluginsMentionItemsParamsSchema.safeParse(params()).success, true);
  assert.equal(
    zcodePluginsMentionItemsParamsSchema.safeParse(params({ query: "x".repeat(1001) })).success,
    false,
  );
  assert.equal(
    zcodePluginsMentionItemsParamsSchema.safeParse({ ...params(), extra: true }).success,
    false,
  );
  const item = { id: "a", label: "A", insertText: "@a" };
  assert.equal(zcodePluginMentionItemsSchema.safeParse([item]).success, true);
  assert.equal(
    zcodePluginMentionItemsSchema.safeParse([{ ...item, extra: true }]).success,
    false,
  );
  assert.equal(
    zcodePluginMentionItemsSchema.safeParse(Array.from({ length: 51 }, () => item)).success,
    false,
  );
});

test("mentionItems resolves the plugin server and returns validated items", async () => {
  const app = appWith({
    result: { structuredContent: { items: [{ id: "a", label: "A", insertText: "@a" }] } },
  });
  const result = await getPluginMentionItems(createContext(app), params());
  assert.deepEqual(result, { items: [{ id: "a", label: "A", insertText: "@a" }] });
  assert.deepEqual(app.calls, [
    {
      serverName: "plugin:mention-plugin:search",
      tool: "mention_search",
      args: { query: "" },
    },
  ]);
});

test("mentionItems fails closed for absent, disabled and conflicting plugins", async () => {
  for (const plugin of [
    undefined,
    { pluginId: PLUGIN_ID, enabled: false, conflictingPluginIds: [] },
    { pluginId: PLUGIN_ID, enabled: true, conflictingPluginIds: ["other@zcode-plugins-official"] },
  ]) {
    const app = appWith();
    app.catalog.plugins = plugin
      ? [
          {
            pluginId: PLUGIN_ID,
            name: "mention-plugin",
            marketplace: "zcode-plugins-official",
            enabled: plugin.enabled,
            conflictingPluginIds: plugin.conflictingPluginIds,
            skillQualifiedNames: [],
            mcpServerNames: ["plugin:mention-plugin:search"],
            subagentNames: [],
          },
        ]
      : [];
    await assert.rejects(getPluginMentionItems(createContext(app), params()), (error) => {
      assert.equal(errorCode(error), ZCODE_PLUGIN_MENTION_ERROR_CODES.pluginUnavailable);
      return true;
    });
    assert.equal(app.calls.length, 0);
  }
});

test("mentionItems rejects unknown and model-only tools without calling them", async () => {
  const unknown = appWith({ visibility: {} });
  await assert.rejects(getPluginMentionItems(createContext(unknown), params()), (error) => {
    assert.equal(errorCode(error), ZCODE_PLUGIN_MENTION_ERROR_CODES.toolNotFound);
    return true;
  });
  assert.equal(unknown.calls.length, 0);

  const modelOnly = appWith({ visibility: { "plugin:mention-plugin:search/mention_search": ["model"] } });
  await assert.rejects(getPluginMentionItems(createContext(modelOnly), params()), (error) => {
    assert.equal(errorCode(error), ZCODE_PLUGIN_MENTION_ERROR_CODES.toolNotAppVisible);
    return true;
  });
  assert.equal(modelOnly.calls.length, 0);
});

test("mentionItems maps authorization denial, tool failure and invalid results", async () => {
  const denied = appWith({ error: createCoreError(CoreErrorType.PermissionDenied, "denied") });
  await assert.rejects(getPluginMentionItems(createContext(denied), params()), (error) => {
    assert.equal(errorCode(error), ZCODE_PLUGIN_MENTION_ERROR_CODES.toolDenied);
    return true;
  });

  const failed = appWith({ error: new Error("boom") });
  await assert.rejects(getPluginMentionItems(createContext(failed), params()), (error) => {
    assert.equal(errorCode(error), ZCODE_PLUGIN_MENTION_ERROR_CODES.toolFailed);
    return true;
  });

  const toolError = appWith({ result: { isError: true } });
  await assert.rejects(getPluginMentionItems(createContext(toolError), params()), (error) => {
    assert.equal(errorCode(error), ZCODE_PLUGIN_MENTION_ERROR_CODES.toolFailed);
    return true;
  });

  const invalid = appWith({ result: { structuredContent: { items: [{ id: 1 }] } } });
  await assert.rejects(getPluginMentionItems(createContext(invalid), params()), (error) => {
    assert.equal(errorCode(error), ZCODE_PLUGIN_MENTION_ERROR_CODES.resultInvalid);
    assert.match((error as Error).message, /items\.0\.(id|label|insertText)/);
    return true;
  });
});

test("mentionItems never cold-starts a session", async () => {
  await assert.rejects(
    getPluginMentionItems(createContext(appWith()), params({ sessionId: "sess_missing" })),
    (error) => {
      assert.equal((error as ProtocolRequestError).code, -32004);
      return true;
    },
  );
});
