// ============================================================
// S6 ToolSearch 连续性：compact 检查点、公告/边界冷恢复与 Local 提升
// ============================================================
// 不变式：
//   1. 发现只来自已提交引用与有效 compact 检查点；compact 成功才写检查点；
//   2. Local 在两次 compact 之间只提升检查点内的原 deferred 工具；
//   3. 公告/边界 metadata 只按严格 schema 恢复，坏字段不丢整份 metadata；
//   4. fork/rewind 走同一份持久消息，不额外生成第二份发现状态。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
  type ModelToolContract,
} from "@zcode/contracts";

import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { collectDiscoveredTools, compactDiscoveryMetadata } from "../src/tool/search/history.js";
import { buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import { buildExposure, localModel, registryOf, toolEntry } from "./tool-search-fixtures.ts";

const SESSION_ID = createSessionId("tool-search-continuity");
const ROOT = "/tmp/tool-search-continuity";

function message(
  id: string,
  created: number,
  parts: MessageWithParts["parts"],
  role: MessageWithParts["info"]["role"] = "user",
): MessageWithParts {
  return {
    info: {
      id: createMessageId(id),
      sessionID: SESSION_ID,
      role,
      time: { created },
      agent: "test",
      mode: "build",
      path: { cwd: ROOT, root: ROOT },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageWithParts["info"],
    parts,
  };
}

function summaryMessage(input: {
  announcement?: unknown;
  boundary?: unknown;
  created?: number;
  text?: string;
  wrapped?: boolean;
}): MessageWithParts {
  const id = `summary-${input.created ?? 1}`;
  const text = input.text ?? "announcement";
  const parts: MessageWithParts["parts"] = [
    {
      id: createPartId(`${id}-text`),
      messageID: createMessageId(id),
      sessionID: SESSION_ID,
      type: "text",
      synthetic: true,
      text: input.wrapped ? `<system-reminder>\n${text}\n</system-reminder>` : text,
      metadata: {
        source: "tool_search_announcement",
        runtimeMessage: {
          source: "tool_search_announcement",
          ...(input.announcement === undefined
            ? {}
            : { toolSearchAnnouncement: input.announcement }),
        },
        ...(input.announcement === undefined ? {} : { toolSearchAnnouncement: input.announcement }),
      },
    },
  ];
  if (input.boundary !== undefined) {
    parts.push({
      id: createPartId(`${id}-boundary`),
      messageID: createMessageId(id),
      sessionID: SESSION_ID,
      type: "compaction",
      compactBoundary: input.boundary as never,
    } as MessageWithParts["parts"][number]);
  }
  return message(id, input.created ?? 1, parts);
}

function toolResult(id: string, created: number, content: unknown): MessageWithParts {
  return message(
    id,
    created,
    [
      {
        id: createPartId(`${id}-part`),
        messageID: createMessageId(id),
        sessionID: SESSION_ID,
        type: "tool",
        callID: `call-${id}`,
        tool: "ToolSearch",
        state: {
          status: "completed",
          input: { query: "select:TodoWrite" },
          output: "legacy",
          title: "ToolSearch",
          metadata: { schemaVersion: 1, modelContent: content },
          time: { start: created, end: created + 1 },
        },
      },
    ],
    "assistant",
  );
}

const entries = [
  toolEntry("ToolSearch"),
  toolEntry("DeferredToolCall"),
  toolEntry("Read"),
  toolEntry("TodoWrite", { shouldDefer: true }),
  toolEntry("WebFetch", { shouldDefer: true }),
];
const tools = entries.map((entry) => ({
  inputSchema: { type: "object" },
  name: entry.metadata.name,
})) satisfies ModelToolContract[];
const registry = registryOf(entries);

describe("compact discovery checkpoint", () => {
  it("只从提交引用与有效边界收集发现，并生成只含名称的边界 metadata", () => {
    const history = new MessageHistoryImpl();
    history.addEntries([
      {
        kind: "attachment",
        content: "checkpoint",
        metadata: {
          source: "legacy_synthetic",
          compactBoundary: {
            boundaryId: "boundary-1",
            preCompactDiscoveredTools: ["WebFetch"],
          },
        },
      },
      {
        message: {
          role: "tool",
          content: [{ type: "tool_reference", toolName: "TodoWrite" }],
          toolCallId: "call-1",
          toolName: "ToolSearch",
        },
      },
      {
        message: {
          role: "tool",
          content: [{ type: "tool_reference", toolName: "Gone" }],
          toolCallId: "call-2",
          toolName: "ToolSearch",
          isError: true,
        },
      },
    ]);
    assert.deepEqual(
      [...collectDiscoveredTools(history.toRuntimeEntries())],
      ["WebFetch", "TodoWrite"],
    );
    assert.deepEqual(
      compactDiscoveryMetadata({
        boundaryId: "boundary-2",
        preCompactDiscoveredTools: ["TodoWrite"],
      }),
      { boundaryId: "boundary-2", preCompactDiscoveredTools: ["TodoWrite"] },
    );
  });

  it("Local 只提升有效检查点内的 deferred 工具，普通搜索不加入 tools", () => {
    const withoutCheckpoint = buildExposure({
      entries: [
        {
          message: {
            role: "tool",
            content: [{ type: "tool_reference", toolName: "TodoWrite" }],
            toolCallId: "call-1",
            toolName: "ToolSearch",
          },
        },
      ],
      mode: "local",
      model: localModel(),
      registry,
      tools,
    });
    assert.equal(
      withoutCheckpoint.tools.some((tool) => tool.name === "TodoWrite"),
      false,
    );

    const promoted = buildExposure({
      entries: [
        {
          kind: "attachment",
          content: "checkpoint",
          metadata: {
            source: "legacy_synthetic",
            compactBoundary: {
              boundaryId: "boundary-1",
              preCompactDiscoveredTools: ["TodoWrite"],
            },
          },
        },
      ],
      mode: "local",
      model: localModel(),
      registry,
      tools,
    });
    assert.equal(
      promoted.tools.some((tool) => tool.name === "TodoWrite"),
      true,
    );
    assert.equal(
      promoted.tools.some((tool) => tool.name === "WebFetch"),
      false,
    );
    assert.equal(
      promoted.tools.some((tool) => tool.name === "DeferredToolCall"),
      true,
    );
  });

  it("compact 公告不把已提升工具重新公告为待加载，只公告真实新增", () => {
    const announcement = buildToolSearchAnnouncement(
      {
        entries: [
          {
            kind: "attachment",
            content: "checkpoint",
            metadata: {
              source: "legacy_synthetic",
              compactBoundary: {
                boundaryId: "boundary-1",
                preCompactDiscoveredTools: ["TodoWrite"],
              },
            },
          },
        ],
        mode: "local",
        model: localModel(),
        registry,
        tools,
      },
      new Set(["TodoWrite"]),
    );
    assert.ok(announcement);
    assert.deepEqual(announcement.metadata?.toolSearchAnnouncement, {
      addedNames: ["WebFetch"],
      removedNames: [],
      readdedNames: [],
    });
    assert.doesNotMatch(announcement.content, /TodoWrite/u);
  });
});

describe("cold hydration of announcement and compact boundary", () => {
  it("恢复公告正文/增量并挂接 compact 检查点", async () => {
    const history = new MessageHistoryImpl();
    await hydrateMessageHistoryFromSession({
      history,
      messages: [
        summaryMessage({
          announcement: { addedNames: ["TodoWrite"], removedNames: [], readdedNames: [] },
          boundary: {
            boundaryId: "boundary-1",
            trigger: "manual",
            preCompactTokenCount: 1,
            summarizedMessageCount: 1,
            summaryMessageIds: [],
            traceId: "trace-1",
            preCompactDiscoveredTools: ["WebFetch"],
          },
          text: "original announcement body",
          wrapped: true,
        }),
      ],
    });
    const hydrated = history.toRuntimeEntries();
    assert.deepEqual(hydrated[0]?.metadata?.toolSearchAnnouncement, {
      addedNames: ["TodoWrite"],
      removedNames: [],
      readdedNames: [],
    });
    assert.equal(hydrated[0]?.kind, "attachment");
    assert.equal(
      hydrated[0]?.kind === "attachment" ? hydrated[0].content : "",
      "original announcement body",
    );
    assert.deepEqual(hydrated[0]?.metadata?.compactBoundary?.preCompactDiscoveredTools, [
      "WebFetch",
    ]);
    assert.deepEqual([...collectDiscoveredTools(hydrated)], ["WebFetch"]);
  });

  it("损坏的公告增量只丢增量字段，保留 source 与 compact 边界", async () => {
    const history = new MessageHistoryImpl();
    await hydrateMessageHistoryFromSession({
      history,
      messages: [
        summaryMessage({
          announcement: { addedNames: ["TodoWrite"], removedNames: [] },
          boundary: {
            boundaryId: "boundary-1",
            trigger: "manual",
            preCompactTokenCount: 1,
            summarizedMessageCount: 1,
            summaryMessageIds: [],
            traceId: "trace-1",
            preCompactDiscoveredTools: ["TodoWrite"],
          },
        }),
      ],
    });
    const hydrated = history.toRuntimeEntries();
    assert.equal(hydrated[0]?.metadata?.source, "tool_search_announcement");
    assert.equal(hydrated[0]?.metadata?.toolSearchAnnouncement, undefined);
    assert.deepEqual(hydrated[0]?.metadata?.compactBoundary?.preCompactDiscoveredTools, [
      "TodoWrite",
    ]);
  });

  it("fork/rewind 只重放有效分支消息，公告与检查点保持一致", async () => {
    const messages = [
      summaryMessage({
        announcement: { addedNames: ["TodoWrite"], removedNames: [], readdedNames: [] },
        boundary: {
          boundaryId: "boundary-1",
          trigger: "manual",
          preCompactTokenCount: 1,
          summarizedMessageCount: 1,
          summaryMessageIds: [],
          traceId: "trace-1",
          preCompactDiscoveredTools: ["TodoWrite"],
        },
        created: 1,
      }),
      toolResult("result-1", 2, [
        { type: "text", text: "loaded" },
        { type: "tool_reference", toolName: "WebFetch" },
      ]),
      toolResult("result-2", 3, [{ type: "tool_reference", toolName: "Gone" }]),
    ];
    for (const mode of ["fork", "rewind"] as const) {
      const history = new MessageHistoryImpl();
      await hydrateMessageHistoryFromSession({
        history,
        messages: messages.slice(0, mode === "fork" ? 2 : 1),
        ...(mode === "fork"
          ? { branchCutAfterMessageId: messages[1]!.info.id }
          : { rewindTargetMessageId: messages[1]!.info.id }),
      });
      const hydrated = history.toRuntimeEntries();
      assert.deepEqual(
        [...collectDiscoveredTools(hydrated)],
        mode === "fork" ? ["TodoWrite", "WebFetch"] : ["TodoWrite"],
      );
      assert.equal(hydrated[0]?.metadata?.source, "tool_search_announcement");
    }
  });
});
