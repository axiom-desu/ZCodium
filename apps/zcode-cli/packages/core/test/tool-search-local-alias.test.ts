// ============================================================
// F17 LocalToolSearch：local 模式的搜索入口用独立名字
// ============================================================
// 不变式：
//   1. local 模式对外工具名是 LocalToolSearch，ToolSearch 仍作为 registry 别名可用；
//   2. 可见性/规则/权限按名字归一，两个名字落到同一条目与同一条权限；
//   3. 历史投影按当前模式改名，且只改请求副本，不动原始历史；
//   4. native 模式仍是 ToolSearch，off 模式不出现控制入口。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LOCAL_TOOL_SEARCH_NAME,
  TOOL_SEARCH_NAME,
  isToolSearchName,
  toolSearchNameForMode,
  type ModelToolContract,
} from "@zcode/contracts";

import {
  buildExposure,
  localModel,
  nativeModel,
  registryOf,
  toolEntry,
} from "./tool-search-fixtures.js";
import { projectToolReferences } from "../src/tool/search/history.js";
import {
  filterDisallowedToolNames,
  isToolNameDisallowed,
  normalizeToolNameAlias,
} from "../src/tool/tool-visibility.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";

const ENTRIES = [
  toolEntry("ToolSearch"),
  toolEntry("DeferredToolCall"),
  toolEntry("Read"),
  toolEntry("TodoWrite", { shouldDefer: true }),
];

const TOOLS: ModelToolContract[] = ENTRIES.map((entry) => ({
  inputSchema: { type: "object" },
  name: entry.metadata.name,
}));

function exposureOf(mode: "native" | "local" | "off") {
  return buildExposure({
    entries: [],
    mode,
    model: mode === "native" ? nativeModel() : localModel(),
    registry: registryOf(ENTRIES),
    tools: TOOLS,
  });
}

describe("LocalToolSearch 名字", () => {
  it("契约：模式 → 工具名，两个名字都算搜索入口", () => {
    assert.equal(toolSearchNameForMode("local"), LOCAL_TOOL_SEARCH_NAME);
    assert.equal(toolSearchNameForMode("native"), TOOL_SEARCH_NAME);
    assert.equal(isToolSearchName(LOCAL_TOOL_SEARCH_NAME), true);
    assert.equal(isToolSearchName(TOOL_SEARCH_NAME), true);
    assert.equal(isToolSearchName("WebSearch"), false);
  });

  it("可见性归一：两个名字映射到同一条权限与规则", () => {
    assert.equal(normalizeToolNameAlias(LOCAL_TOOL_SEARCH_NAME), TOOL_SEARCH_NAME);
    assert.equal(isToolNameDisallowed("LocalToolSearch", ["ToolSearch"]), true);
    assert.equal(isToolNameDisallowed("ToolSearch", ["LocalToolSearch"]), true);
    assert.deepEqual(filterDisallowedToolNames(["LocalToolSearch"], ["ToolSearch"]), []);
  });

  it("registry 别名：模型混用任一名字都能命中同一条目", () => {
    assert.ok(toolSearchToolEntry.aliases?.includes(LOCAL_TOOL_SEARCH_NAME));
    assert.equal(toolSearchToolEntry.metadata.name, TOOL_SEARCH_NAME);
  });

  it("local 暴露 LocalToolSearch，native 暴露 ToolSearch，off 不暴露控制入口", () => {
    const local = exposureOf("local");
    assert.deepEqual(
      local.tools.map((tool) => tool.name).sort(),
      // 常驻 Read + 两个控制入口；deferred 的 TodoWrite 不直接发送。
      ["DeferredToolCall", "LocalToolSearch", "Read"],
    );
    const native = exposureOf("native");
    assert.ok(native.tools.some((tool) => tool.name === TOOL_SEARCH_NAME));
    assert.ok(!native.tools.some((tool) => tool.name === LOCAL_TOOL_SEARCH_NAME));
    const off = exposureOf("off");
    assert.ok(!off.tools.some((tool) => isToolSearchName(tool.name)));
  });

  it("历史投影只在请求副本里改名，原文与别名都能识别为成功搜索", () => {
    const entries = [
      {
        kind: "message" as const,
        message: {
          content: [
            { toolName: "TodoWrite", type: "tool_reference" as const },
          ],
          role: "tool" as const,
          toolCallId: "call_1",
          toolName: LOCAL_TOOL_SEARCH_NAME,
        },
        metadata: { source: "assistant" as const },
      },
    ];
    const native = projectToolReferences(entries, "native", TOOLS);
    const renamed = native.entries[0];
    assert.ok(renamed && renamed.kind !== "attachment");
    if (renamed && renamed.kind !== "attachment") {
      assert.equal(renamed.message.toolName, TOOL_SEARCH_NAME);
    }
    // 原始历史不变。
    assert.equal(entries[0]!.message.toolName, LOCAL_TOOL_SEARCH_NAME);
    // native 模式下引用仍然可以直接用（引用内容保留，不是被丢弃）。
    assert.equal(native.loadedToolCallIds.has("call_1"), true);
  });
});
