// context composition 分类纯函数与投影的唯一真值守卫（上游 3.18.2 F4，C7 片）。
// 只测纯函数：真实 runtime 的查询/冷状态/失效在 bootstrap 协议测试里跑。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTEXT_COMPOSITION_CATEGORY_IDS,
  CONTEXT_COMPOSITION_MAX_ITEMS,
  CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS,
  contextCompositionUsageSource,
} from "@zcode/shared/zcode-protocol-v4";
import {
  classifyContextComposition,
  projectContextCompositionToUsageSources,
  toContextCompositionCategories,
} from "../src/runtime/context-composition/classifier.js";
import type { ModelToolContract } from "../src/runtime/deps.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { ModelInputMessage } from "../src/agent/message-history.js";

const SYSTEM_SECTION = {
  name: "system",
  source: "system",
  injectionTarget: "system" as const,
  chars: 10,
  tokens: 3,
};
const META_SECTION = {
  name: "instructions",
  source: "instructions",
  injectionTarget: "meta_user" as const,
  chars: 99,
  tokens: 33,
};
const TOOL_SECTION = {
  name: "tools",
  source: "tools",
  injectionTarget: "system" as const,
  chars: 20,
  tokens: 5,
};
const SKILLS_SECTION = {
  name: "skills",
  source: "skills",
  injectionTarget: "system" as const,
  chars: 30,
  tokens: 7,
};

function user(content: string): ModelInputMessage {
  return { role: "user", content };
}

function entry(
  message: ModelInputMessage,
  source: RuntimeMessageEntry["metadata"] extends infer _ ? string : never,
  extra: Record<string, unknown> = {},
): RuntimeMessageEntry {
  return {
    message,
    metadata: { source, ...extra } as RuntimeMessageEntry["metadata"],
  };
}

function tool(name: string, overrides: Record<string, unknown> = {}): ModelToolContract {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  } as unknown as ModelToolContract;
}

describe("classifyContextComposition", () => {
  it("sections、提醒、新轮通知、compact 摘要与工具各落到正确的细类别", () => {
    const messages: ModelInputMessage[] = [
      user("hello"),
      entry(user("<system-reminder>env</system-reminder>"), "runtime_mode").message,
      entry(user("<system-reminder>skill list</system-reminder>"), "skills_listing").message,
      entry(user("<system-reminder>prefix</system-reminder>"), "context_prefix").message,
      entry(user("wrapped notification"), "background_task", {
        inputPresentation: "task_notification",
      }).message,
      entry(user("compact summary"), "context_prefix", {
        compactBoundary: { boundaryId: "b1" },
      }).message,
    ];
    const sourceEntries = [
      undefined,
      entry(messages[1]!, "runtime_mode"),
      entry(messages[2]!, "skills_listing"),
      entry(messages[3]!, "context_prefix"),
      entry(messages[4]!, "background_task", { inputPresentation: "task_notification" }),
      entry(messages[5]!, "context_prefix", { compactBoundary: { boundaryId: "b1" } }),
    ];

    const breakdown = classifyContextComposition({
      sections: [SYSTEM_SECTION, META_SECTION, TOOL_SECTION, SKILLS_SECTION],
      messages,
      sourceEntries,
      tools: [
        tool("Read"),
        tool("mcp__server__tool"),
        tool("app__page__tool"),
        tool("discovered-deferred", { deferLoading: true }),
      ],
    });

    // 11 个细类别恒在，顺序即线格式顺序。
    assert.deepEqual(
      breakdown.categories.map((category) => category.id),
      [...CONTEXT_COMPOSITION_CATEGORY_IDS],
    );
    const tokens = (id: string) =>
      breakdown.categories.find((category) => category.id === id)!.tokens;
    assert.ok(tokens("system_prompt") > 0);
    assert.ok(tokens("tool_prompt") > 0);
    assert.ok(tokens("skills") > 0);
    // meta_user 注入的 section 不按 section 计（正文已是历史里的公告）。
    assert.equal(tokens("meta_user_context"), tokens("meta_user_context"));
    assert.ok(tokens("reminders") > 0);
    assert.ok(tokens("compact_summary") > 0);
    assert.ok(tokens("app_tool_schemas") > 0);
    assert.ok(tokens("deferred_tool_schemas") > 0);
    assert.ok(tokens("mcp_tool_schemas") > 0);
    assert.ok(tokens("messages") > 0);

    const names = (id: string) =>
      breakdown.categories
        .find((category) => category.id === id)!
        .items.map((item) => item.name);
    // 延迟加载工具只计名字与描述：按来源归内置/MCP，不落内置 schema 类别。
    assert.deepEqual(names("system_tool_schemas"), ["Read"]);
    assert.deepEqual(names("app_tool_schemas"), ["app__page__tool"]);
    assert.deepEqual(names("deferred_tool_schemas"), ["discovered-deferred"]);
    // compact 摘要单独成类，不再埋在 messages 里。
    assert.deepEqual(names("compact_summary"), ["compact_summary"]);
  });

  it("技能与指令条目只作明细，类别大小取公告真实文本，不重复累计", () => {
    const breakdown = classifyContextComposition({
      sections: [SKILLS_SECTION],
      messages: [entry(user("<system-reminder>prefix</system-reminder>"), "context_prefix").message],
      sourceEntries: [entry(user(""), "context_prefix")],
      tools: [],
      skillItems: [{ name: "skill-a", chars: 5, tokens: 2 }],
      instructionItems: [{ name: "/ws/AGENTS.md", chars: 4, tokens: 1 }],
    });
    const skills = breakdown.categories.find((category) => category.id === "skills")!;
    assert.equal(skills.tokens, SKILLS_SECTION.tokens);
    assert.deepEqual(
      skills.items.map((item) => item.name),
      ["skill-a"],
    );
    const meta = breakdown.categories.find((category) => category.id === "meta_user_context")!;
    // 公告正文的 token 保留在类别大小里，条目来自指令元数据。
    assert.deepEqual(
      meta.items.map((item) => item.name),
      ["/ws/AGENTS.md"],
    );
  });

  it("圆环只有现有 7 个粗类别，且每个细类别按子 spec 的表投影", () => {
    const breakdown = classifyContextComposition({
      sections: [SYSTEM_SECTION, TOOL_SECTION, SKILLS_SECTION],
      messages: [entry(user("prefix"), "context_prefix").message],
      sourceEntries: [entry(user("prefix"), "context_prefix")],
      tools: [
        tool("Read"),
        tool("mcp__server__tool"),
        tool("app__page__tool"),
        tool("mcp__server__deferred", { deferLoading: true }),
        tool("system-deferred", { deferLoading: true }),
      ],
    });
    const sources = projectContextCompositionToUsageSources(breakdown).map(
      (category) => category.source,
    );
    // 只有 context_prefix 的 user 文本：它归 meta_user_context，所以没有 messages 粗类别。
    assert.deepEqual(sources, [
      "system_prompt",
      "meta_user_context",
      "skills",
      "tool_prompt",
      "system_tool_schemas",
      "mcp_tool_schemas",
    ]);
    assert.equal(contextCompositionUsageSource("app_tool_schemas"), "system_tool_schemas");
    assert.equal(contextCompositionUsageSource("reminders"), "meta_user_context");
    assert.equal(contextCompositionUsageSource("compact_summary"), "messages");
    assert.equal(
      contextCompositionUsageSource("deferred_tool_schemas", "mcp"),
      "mcp_tool_schemas",
    );
  });

  it("线格式：0 值类别不返回、条目最多 50 条、名字截断到 200 字符", () => {
    const manyTools = Array.from({ length: 60 }, (_, index) => tool(`tool-${index}`));
    const longName = "x".repeat(CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS + 40);
    const breakdown = classifyContextComposition({
      sections: [{ ...SYSTEM_SECTION, name: longName }],
      messages: [],
      tools: manyTools,
    });
    const wire = toContextCompositionCategories(breakdown);
    assert.ok(wire.every((category) => category.tokens > 0));
    const tools = wire.find((category) => category.id === "system_tool_schemas")!;
    assert.equal(tools.items?.length, CONTEXT_COMPOSITION_MAX_ITEMS);
    // token 降序（同 token 时保持插入顺序，不断言具体名字）。
    const sorted = [...tools.items!].sort((left, right) => right.tokens - left.tokens);
    assert.deepEqual(tools.items, sorted);
    const system = wire.find((category) => category.id === "system_prompt")!;
    assert.equal(
      system.items?.[0]?.name.length,
      CONTEXT_COMPOSITION_MAX_ITEM_NAME_CHARS,
    );
  });
});
