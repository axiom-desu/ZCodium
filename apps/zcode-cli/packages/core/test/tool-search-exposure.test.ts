// ============================================================
// S6 ToolSearch：暴露决策、引用投影与包装调用准入
// ============================================================
// 不变式：
//   1. 请求只暴露常驻定义；Native 仅追加已发现 deferred，Local 只发常驻+控制入口；
//   2. 控制入口缺失或无 deferred 时退化为全目录，不能静默丢工具；
//   3. 包装调用只接受当前请求允许的 deferred 目标，目标 part 用目标身份 + 包装标记。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model, ModelToolContract, ToolSearchExecutionContext } from "@zcode/contracts";
import {
  buildExposure,
  buildModelRequestMessages,
  buildWrapperCall,
  registryOf,
  localModel,
  nativeModel,
  toolEntry,
} from "./tool-search-fixtures.ts";

describe("buildToolExposure", () => {
  const entries = [
    toolEntry("ToolSearch"),
    toolEntry("DeferredToolCall"),
    toolEntry("Read"),
    toolEntry("TodoWrite", { shouldDefer: true }),
    toolEntry("WebFetch", { shouldDefer: true }),
    toolEntry("mcp__s__t", { mcpPresentation: { serverName: "s", toolName: "t" } }),
  ];
  const tools = entries.map((entry) => ({
    inputSchema: { type: "object" },
    name: entry.metadata.name,
  })) satisfies ModelToolContract[];

  it("off 发送完整目录并隐藏控制入口", () => {
    const exposure = buildExposure({
      entries: [],
      mode: "off",
      tools,
      registry: registryOf(entries),
    });
    assert.equal(exposure.enabled, false);
    assert.equal(exposure.context.mode, "off");
    assert.deepEqual(
      exposure.tools.map((tool) => tool.name).sort(),
      ["Read", "TodoWrite", "WebFetch", "mcp__s__t"].sort(),
    );
  });

  it("native 首轮只发常驻定义，deferred 目标不带 schema", () => {
    const exposure = buildExposure({
      entries: [],
      mode: "native",
      model: nativeModel(),
      tools,
      registry: registryOf(entries),
    });
    assert.equal(exposure.context.mode, "native");
    assert.deepEqual(exposure.tools.map((tool) => tool.name).sort(), ["Read", "ToolSearch"].sort());
    assert.equal(exposure.reason, "native");
  });

  it("native 发现后只追加已发现 deferred 并标 deferLoading", () => {
    const exposure = buildExposure({
      entries: [
        {
          message: {
            content: [
              { type: "text", text: "found" },
              { type: "tool_reference", toolName: "TodoWrite" },
            ],
            role: "tool",
            toolCallId: "call-1",
            toolName: "ToolSearch",
          },
        },
      ],
      mode: "native",
      model: nativeModel(),
      tools,
      registry: registryOf(entries),
    });
    const byName = new Map(exposure.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("TodoWrite")?.deferLoading, true);
    assert.equal(byName.get("WebFetch"), undefined);
    assert.equal(byName.get("Read")?.deferLoading, undefined);
  });

  it("local 发送常驻+两个控制入口，目标 schema 不进 tools", () => {
    const exposure = buildExposure({
      entries: [],
      mode: "local",
      model: localModel(),
      tools,
      registry: registryOf(entries),
    });
    assert.equal(exposure.context.mode, "local");
    assert.deepEqual(
      exposure.tools.map((tool) => tool.name).sort(),
      ["DeferredToolCall", "Read", "ToolSearch"].sort(),
    );
    assert.ok(exposure.tools.every((tool) => tool.deferLoading === undefined));
    // Local 的 ToolSearch 描述与 Native 不同：明确要求通过 DeferredToolCall 调用。
    assert.match(
      exposure.tools.find((tool) => tool.name === "ToolSearch")?.description ?? "",
      /DeferredToolCall/,
    );
  });

  it("控制入口缺失时退化为全目录并给出原因", () => {
    const withoutControls = entries.filter(
      (entry) => entry.metadata.name !== "ToolSearch" && entry.metadata.name !== "DeferredToolCall",
    );
    const exposure = buildExposure({
      entries: [],
      mode: "local",
      model: localModel(),
      tools: withoutControls.map((entry) => ({
        inputSchema: { type: "object" },
        name: entry.metadata.name,
      })),
      registry: registryOf(withoutControls),
    });
    assert.equal(exposure.enabled, false);
    assert.equal(exposure.context.mode, "off");
    assert.equal(exposure.reason, "tool_unavailable");
    assert.equal(exposure.tools.length, withoutControls.length);
  });

  it("没有 deferred 工具时关闭搜索", () => {
    const resident = [toolEntry("ToolSearch"), toolEntry("DeferredToolCall"), toolEntry("Read")];
    const exposure = buildExposure({
      entries: [],
      mode: "local",
      model: localModel(),
      tools: resident.map((entry) => ({
        inputSchema: { type: "object" },
        name: entry.metadata.name,
      })),
      registry: registryOf(resident),
    });
    assert.equal(exposure.reason, "no_deferred_tools");
    assert.equal(exposure.context.mode, "off");
  });
});

describe("projectToolReferences", () => {
  const entries = [
    toolEntry("ToolSearch"),
    toolEntry("DeferredToolCall"),
    toolEntry("TodoWrite", { shouldDefer: true }),
  ];
  const tools = entries.map((entry) => ({
    inputSchema: { type: "object", properties: { todos: { type: "array" } } },
    description: `${entry.metadata.name} description`,
    name: entry.metadata.name,
  })) satisfies ModelToolContract[];
  const toolResult = {
    message: {
      content: [
        { type: "tool_reference" as const, toolName: "TodoWrite" },
        { type: "tool_reference" as const, toolName: "Gone" },
      ],
      role: "tool" as const,
      toolCallId: "call-1",
      toolName: "ToolSearch",
    },
  };

  it("local 在结果内展开 schema 并追加一次 Loaded 指引，不产出外部提示", () => {
    const result = buildExposure({
      entries: [toolResult],
      mode: "local",
      model: localModel(),
      tools,
      registry: registryOf(entries),
    });
    assert.equal(result.loadedToolCallIds.size, 0);
    const projected = result.entries[0]!;
    if (projected.kind === "attachment" || typeof projected.message.content === "string")
      throw new Error("expected structured tool content");
    const text = projected.message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    assert.match(text, /<functions>/);
    assert.match(text, /"name":"TodoWrite"/);
    assert.match(text, /Loaded: TodoWrite/);
    assert.equal(
      projected.message.content.some((block) => block.type === "tool_reference"),
      false,
    );
  });

  it("native 保留引用并派生结果外 Tool loaded 提示，Off 替换为占位", () => {
    const native = buildExposure({
      entries: [toolResult],
      mode: "native",
      model: nativeModel(),
      tools,
      registry: registryOf(entries),
    });
    assert.equal(native.loadedToolCallIds.has("call-1"), true);
    const off = buildExposure({
      entries: [toolResult],
      mode: "off",
      tools,
      registry: registryOf(entries),
    });
    const projected = off.entries[0]!;
    if (projected.kind === "attachment" || typeof projected.message.content === "string")
      throw new Error("expected structured tool content");
    assert.deepEqual(projected.message.content, [
      { type: "text", text: "[Tool references removed - tool search not enabled]" },
    ]);
  });

  it("请求投影把内部目标身份还原成 DeferredToolCall 包装", () => {
    const messages = buildModelRequestMessages(
      [
        {
          message: {
            content: "",
            role: "assistant",
            toolCalls: [
              {
                id: "call-1",
                input: { todos: [] },
                modelCallWrapper: "DeferredToolCall",
                name: "TodoWrite",
              },
            ],
          },
        },
        toolResult,
      ],
      "off",
    );
    assert.equal(messages[0]?.toolCalls?.[0]?.name, "DeferredToolCall");
    assert.deepEqual(messages[0]?.toolCalls?.[0]?.input, {
      name: "TodoWrite",
      input: { todos: [] },
    });
    assert.equal(messages[0]?.toolCalls?.[0]?.id, "call-1");
  });
});

describe("resolveDeferredToolCall", () => {
  const entries = [
    toolEntry("ToolSearch"),
    toolEntry("DeferredToolCall"),
    toolEntry("Read"),
    toolEntry("TodoWrite", { shouldDefer: true }),
  ];
  const registry = registryOf(entries);
  const context = {
    catalog: [
      { deferred: false, name: "ToolSearch" },
      { deferred: false, name: "DeferredToolCall" },
      { deferred: false, name: "Read" },
      { deferred: true, name: "TodoWrite" },
    ],
    discovered: new Set<string>(),
    enabled: true,
    mode: "local",
  } satisfies ToolSearchExecutionContext;

  it("常驻目标按直接调用拒绝，包装身份保持不变", () => {
    const admission = buildWrapperCall(
      { id: "c", input: { input: {}, name: "Read" }, name: "DeferredToolCall" },
      context,
      registry,
    );
    assert.ok(admission.error);
    assert.equal(admission.call.name, "DeferredToolCall");
  });

  it("deferred 目标解包为目标身份并带包装标记", () => {
    const admission = buildWrapperCall(
      {
        id: "c",
        input: { input: { todos: [{ content: "x" }] }, name: "TodoWrite" },
        name: "DeferredToolCall",
      },
      context,
      registry,
    );
    assert.equal(admission.error, undefined);
    assert.equal(admission.call.name, "TodoWrite");
    assert.deepEqual(admission.call.input, { todos: [{ content: "x" }] });
    assert.equal(admission.call.modelCallWrapper, "DeferredToolCall");
  });

  it("搜索未启用或目标不在本次允许目录时拒绝", () => {
    assert.ok(
      buildWrapperCall(
        { id: "c", input: { input: {}, name: "TodoWrite" }, name: "DeferredToolCall" },
        { ...context, enabled: false },
        registry,
      ).error,
    );
    assert.ok(
      buildWrapperCall(
        { id: "c", input: { input: {}, name: "WebFetch" }, name: "DeferredToolCall" },
        context,
        registry,
      ).error,
    );
  });

  it("普通调用不经包装路径", () => {
    const call = { id: "c", input: {}, name: "Read" };
    const admission = buildWrapperCall(call, context, registry);
    assert.equal(admission.call, call);
  });
});

// 保证 `Model` 类型在本文件被真实引用（fixtures 只负责构造）。
const _model: Model = nativeModel();
void _model;
