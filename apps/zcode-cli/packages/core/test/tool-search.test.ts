// ============================================================
// S6 ToolSearch：搜索语义、schema 声明与公告增量事实
// ============================================================
// 三条不变式：
//   1. 搜索只对当前 deferred 目录生效；select 走 canonical/alias/MCP 短名，关键词用分词加权；
//   2. 模型侧 JSON Schema 把 query/max_results 同时声明为 required，runtime schema 仍接受省略；
//   3. 公告只从已提交的增量事实重算，目录不变不重复公告，删除对照完整工具池。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolSearchAnnouncementSchema,
  ToolSearchInputJsonSchema,
  ToolSearchInputSchema,
  ToolSearchModeSchema,
  type Model,
  type ModelToolContract,
  type ToolSearchCandidate,
} from "@zcode/contracts";
import { searchTools } from "../src/tool/search/search.js";
import {
  buildToolSearchAnnouncement,
  isDeferredTool,
  resolveToolSearchMode,
} from "../src/tool/search/exposure.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { ToolEntry } from "../src/tool/types.js";

const catalog: ToolSearchCandidate[] = [
  {
    name: "TodoWrite",
    description: "Manage the session task checklist",
    searchHint: "manage the session task checklist",
    deferred: true,
  },
  {
    name: "WebFetch",
    searchHint: "fetch and extract content from a URL",
    deferred: true,
  },
  {
    name: "mcp__github__create_issue",
    mcp: { serverName: "github", toolName: "create_issue" },
    description: "Open a github issue",
    deferred: true,
  },
  {
    name: "mcp__slack__post",
    aliases: ["PostSlack"],
    mcp: { serverName: "slack", toolName: "post" },
    searchHint: "send a slack message",
    deferred: true,
  },
  {
    name: "Read",
    description: "Read a file",
    deferred: false,
  },
];

function model(input: { api: string; supportsToolCall?: boolean; codingPlan?: boolean }): Model {
  const protocolSupported = input.api === "anthropic-messages";
  return {
    modelId: "m",
    properties: {
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      supportsToolCall: input.supportsToolCall ?? true,
      supportsVision: false,
      supportsReasoning: false,
    },
    providerId: "p",
    requestCapabilities: {
      toolSearch: {
        protocolSupported,
        defaultEnabled: protocolSupported && input.codingPlan === true,
      },
    },
  } as unknown as Model;
}

function tool(name: string, extra: Partial<ModelToolContract> = {}): ModelToolContract {
  return { inputSchema: { type: "object" }, name, ...extra };
}

function entry(metadata: RuntimeMessageEntry["metadata"], text = "notice"): RuntimeMessageEntry {
  return { content: text, kind: "attachment", metadata: metadata! };
}

function registryOf(entries: readonly ToolEntry[]): { get(name: string): ToolEntry | undefined } {
  const map = new Map(entries.map((tool) => [tool.metadata.name, tool]));
  return { get: (name) => map.get(name) };
}

function metadata(name: string, extra: Record<string, unknown> = {}) {
  return { name, readOnly: false, destructive: false, concurrentSafe: true, ...extra };
}

describe("ToolSearch schema contracts", () => {
  it("模型侧 schema 要求 query 与 max_results，runtime schema 仍接受省略默认 5", () => {
    assert.deepEqual(ToolSearchInputJsonSchema.required, ["query", "max_results"]);
    assert.deepEqual(ToolSearchInputSchema.parse({ query: "todo" }), {
      query: "todo",
      max_results: 5,
    });
  });

  it("模式枚举只接受 auto/native/local/off", () => {
    for (const value of ["auto", "native", "local", "off"]) {
      assert.equal(ToolSearchModeSchema.parse(value), value);
    }
    assert.equal(ToolSearchModeSchema.safeParse("enabled").success, false);
  });

  it("公告增量拒绝不在 addedNames 内的 readdedNames", () => {
    assert.equal(
      ToolSearchAnnouncementSchema.safeParse({
        addedNames: ["A"],
        removedNames: [],
        readdedNames: ["B"],
      }).success,
      false,
    );
  });
});

describe("resolveToolSearchMode", () => {
  it("auto 只在 Coding Plan Anthropic 选 native，其他可工具调用的模型走 local", () => {
    assert.equal(
      resolveToolSearchMode(model({ api: "anthropic-messages", codingPlan: true }), "auto"),
      "native",
    );
    assert.equal(resolveToolSearchMode(model({ api: "anthropic-messages" }), "auto"), "local");
    assert.equal(resolveToolSearchMode(model({ api: "openai-responses" }), "auto"), "local");
  });

  it("显式 native/local 在不支持时必须报错，off 与不支持工具调用时保持关闭", () => {
    assert.throws(() => resolveToolSearchMode(model({ api: "openai-responses" }), "native"));
    assert.throws(() =>
      resolveToolSearchMode(model({ api: "openai-responses", supportsToolCall: false }), "local"),
    );
    assert.equal(
      resolveToolSearchMode(model({ api: "openai-responses", supportsToolCall: false }), "auto"),
      "off",
    );
    assert.equal(resolveToolSearchMode(model({ api: "anthropic-messages" }), "off"), "off");
  });
});

describe("isDeferredTool", () => {
  it("常驻、控制入口与 provider 原生工具永不 deferred", () => {
    const metadataWith = (extra: Record<string, unknown>) =>
      metadata("X", extra) as unknown as ToolEntry["metadata"];
    assert.equal(isDeferredTool(tool("X"), metadataWith({ shouldDefer: true })), true);
    assert.equal(
      isDeferredTool(tool("X"), metadataWith({ alwaysLoad: true, shouldDefer: true })),
      false,
    );
    assert.equal(isDeferredTool(tool("ToolSearch"), metadataWith({ shouldDefer: true })), false);
    assert.equal(
      isDeferredTool(tool("DeferredToolCall"), metadataWith({ shouldDefer: true })),
      false,
    );
    assert.equal(
      isDeferredTool(
        tool("X", { providerNative: { logicalName: "WebSearch", type: "web_search" } as never }),
        metadataWith({ shouldDefer: true }),
      ),
      false,
    );
    // MCP 工具默认延迟，不需要 shouldDefer。
    assert.equal(
      isDeferredTool(
        tool("mcp__s__t"),
        metadataWith({ mcpPresentation: { serverName: "s", toolName: "t" } }),
      ),
      true,
    );
  });
});

describe("searchTools", () => {
  it("select 支持 canonical 与 alias，未命中再按 MCP 短名匹配并去重", () => {
    assert.deepEqual(searchTools("select:TodoWrite,PostSlack", catalog), [
      "TodoWrite",
      "mcp__slack__post",
    ]);
    assert.deepEqual(searchTools("select:create_issue", catalog), ["mcp__github__create_issue"]);
    assert.deepEqual(searchTools("select:TodoWrite,TodoWrite", catalog), ["TodoWrite"]);
  });

  it("关键词只命中 deferred，常驻工具只能按精确名称选择", () => {
    assert.deepEqual(searchTools("zzz", catalog), []);
    assert.deepEqual(searchTools("select:Read", catalog), ["Read"]);
    assert.deepEqual(searchTools("TodoWrite", catalog), ["TodoWrite"]);
    // 精确名称也接受常驻工具：直接把定义选择出来。
    assert.deepEqual(searchTools("read", catalog), ["Read"]);
  });

  it("+required 是名称/hint/description 的硬条件，其余词只参与排序", () => {
    assert.deepEqual(searchTools("+slack message", catalog), ["mcp__slack__post"]);
    assert.deepEqual(searchTools("+nonexistent todo", catalog), []);
  });

  it("正则特殊字符按字面匹配，不抛异常", () => {
    assert.deepEqual(searchTools("create.issue(", catalog), []);
  });

  it("max_results 只截断关键词结果，不截断 select", () => {
    assert.deepEqual(searchTools("e", catalog, 1).length, 1);
    assert.equal(searchTools("select:TodoWrite,WebFetch,mcp__slack__post", catalog, 1).length, 3);
  });
});

describe("buildToolSearchAnnouncement", () => {
  const tools = [
    tool("ToolSearch"),
    tool("DeferredToolCall"),
    tool("TodoWrite"),
    tool("WebFetch"),
    tool("Read"),
  ];
  const registry = registryOf([
    { metadata: metadata("ToolSearch") },
    { metadata: metadata("DeferredToolCall") },
    { metadata: metadata("TodoWrite", { shouldDefer: true }) },
    { metadata: metadata("WebFetch", { shouldDefer: true }) },
    { metadata: metadata("Read") },
  ] as ToolEntry[]);
  const localModel = model({ api: "openai-responses" });

  it("首次收集只列 deferred 名称，metadata 记录增量事实", () => {
    const result = buildToolSearchAnnouncement({
      entries: [],
      model: localModel,
      mode: "local",
      registry,
      tools,
    });
    assert.equal(result?.kind, "attachment");
    if (result?.kind !== "attachment") throw new Error("expected attachment");
    assert.match(result.content, /TodoWrite/);
    assert.match(result.content, /WebFetch/);
    assert.doesNotMatch(result.content, /\nRead/);
    assert.deepEqual(result.metadata.toolSearchAnnouncement, {
      addedNames: ["TodoWrite", "WebFetch"],
      removedNames: [],
      readdedNames: [],
    });
  });

  it("同一目录再次收集不重复公告", () => {
    const first = buildToolSearchAnnouncement({
      entries: [],
      model: localModel,
      mode: "local",
      registry,
      tools,
    });
    if (first?.kind !== "attachment") throw new Error("expected attachment");
    const second = buildToolSearchAnnouncement({
      entries: [first],
      model: localModel,
      mode: "local",
      registry,
      tools,
    });
    assert.equal(second, undefined);
  });

  it("compact 只保留部分公告时，未完整列名的工具在尾部补列", () => {
    // 旧公告正文只列过 WebFetch；TodoWrite 从未在正文出现过，必须补列。
    const truncatedDelta = {
      addedNames: ["WebFetch"],
      removedNames: [],
      readdedNames: [],
    };
    const result = buildToolSearchAnnouncement({
      entries: [
        entry({ source: "tool_search_announcement", toolSearchAnnouncement: truncatedDelta }),
      ],
      model: localModel,
      mode: "local",
      registry,
      tools,
    });
    if (result?.kind !== "attachment") throw new Error("expected attachment");
    assert.deepEqual(result.metadata.toolSearchAnnouncement, {
      addedNames: ["TodoWrite"],
      removedNames: [],
      readdedNames: [],
    });
    assert.match(result.content, /TodoWrite/);
    assert.doesNotMatch(result.content, /WebFetch/);
  });

  it("删除对照完整工具池：deferred 转常驻不误报不可用", () => {
    const announced = {
      addedNames: ["TodoWrite"],
      removedNames: [],
      readdedNames: [],
    };
    const result = buildToolSearchAnnouncement({
      entries: [entry({ source: "tool_search_announcement", toolSearchAnnouncement: announced })],
      model: model({ api: "anthropic-messages", codingPlan: true }),
      mode: "native",
      registry: registryOf([
        { metadata: metadata("ToolSearch") },
        { metadata: metadata("TodoWrite", { shouldDefer: true, alwaysLoad: true }) },
      ] as ToolEntry[]),
      tools: [tool("ToolSearch"), tool("TodoWrite")],
    });
    // 目录里仍有 TodoWrite：常驻化不是删除，但也不再是 deferred；无新增即不公告。
    assert.equal(result, undefined);
  });

  it("真正消失的工具只在删除段公告一次", () => {
    const announced = {
      addedNames: ["TodoWrite"],
      removedNames: [],
      readdedNames: [],
    };
    const result = buildToolSearchAnnouncement({
      entries: [entry({ source: "tool_search_announcement", toolSearchAnnouncement: announced })],
      model: localModel,
      mode: "local",
      registry,
      tools: [tool("ToolSearch"), tool("DeferredToolCall"), tool("WebFetch"), tool("Read")],
    });
    if (result?.kind !== "attachment") throw new Error("expected attachment");
    assert.match(result.content, /no longer available/);
    // 同一份目录变化会同时宣布仍未公告的 WebFetch 与已消失的 TodoWrite。
    assert.deepEqual(result.metadata.toolSearchAnnouncement, {
      addedNames: ["WebFetch"],
      removedNames: ["TodoWrite"],
      readdedNames: [],
    });
  });

  it("关闭 ToolSearch 时不产生公告", () => {
    assert.equal(
      buildToolSearchAnnouncement({
        entries: [],
        model: localModel,
        mode: "off",
        registry,
        tools,
      }),
      undefined,
    );
  });
});
