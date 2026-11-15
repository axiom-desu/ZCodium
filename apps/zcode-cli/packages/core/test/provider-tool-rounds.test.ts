// Provider 内置工具多轮回放（上游 3.18.2 F11）：轮次 entries、compact 分组键、冷恢复切轮。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CompactTrigger } from "@zcode/contracts";

import { createMessageHistory } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { selectCompactEntries } from "../src/runtime/helpers/compact-selection.js";
import {
  createProviderToolRoundEntries,
  hasProviderToolRoundContent,
  providerToolRoundsCompactGroupKey,
  type ProviderToolRound,
} from "../src/runtime/provider-tool-rounds/contract.js";

const MODEL = { modelId: "fixture-model", providerId: "fixture-provider" };

function round(id: string, text: string): ProviderToolRound {
  return {
    messageId: "m1",
    reasoning: [{ providerOptions: { signature: "s" }, text: "thinking", type: "reasoning" }],
    text,
    toolCall: { id, input: { prompt: "read" }, name: "analyze_image", providerExecuted: true },
    result: { isError: false, output: "Order Console" },
  };
}

function textPart(id: string, text: string) {
  return {
    id,
    messageID: "m1",
    sessionID: "s1",
    text,
    time: { end: 2, start: 1 },
    type: "text" as const,
  };
}

function providerToolPart(id: string, callID: string) {
  return {
    callID,
    id,
    messageID: "m1",
    metadata: { providerExecuted: true },
    sessionID: "s1",
    state: {
      input: { prompt: "read" },
      metadata: { display: { kind: "mcp_tool", serverName: "server", toolName: "analyze_image" } },
      output: "Order Console",
      status: "completed" as const,
      time: { end: 2, start: 1 },
      title: "analyze_image",
    },
    tool: "analyze_image",
    type: "tool" as const,
  };
}

function localToolPart(id: string, callID: string) {
  return {
    callID,
    id,
    messageID: "m1",
    metadata: {},
    sessionID: "s1",
    state: {
      input: { path: "a.txt" },
      output: "file content",
      status: "completed" as const,
      time: { end: 2, start: 1 },
      title: "Read",
    },
    tool: "Read",
    type: "tool" as const,
  };
}

function assistantMessage(parts: unknown[]) {
  return {
    info: {
      id: "m1",
      modelId: MODEL.modelId,
      providerId: MODEL.providerId,
      role: "assistant",
      sessionID: "s1",
      time: { created: 1 },
      tokens: { cache: { read: 0, write: 0 }, input: 10, output: 5, reasoning: 0, total: 15 },
    },
    parts,
  } as never;
}

describe("provider tool rounds", () => {
  it("前序轮次回放为 assistant(text, toolCall) + tool(result)", () => {
    const entries = createProviderToolRoundEntries([round("srv_1", "before")], MODEL);
    assert.equal(entries.length, 2);
    const assistant = entries[0]!;
    assert.equal(assistant.kind, undefined);
    assert.equal(assistant.message.role, "assistant");
    assert.deepEqual(assistant.message.toolCalls, [
      { id: "srv_1", input: { prompt: "read" }, name: "analyze_image" },
    ]);
    const tool = entries[1]!;
    assert.equal(tool.message.role, "tool");
    assert.equal(tool.message.toolCallId, "srv_1");
    assert.equal(hasProviderToolRoundContent([round("srv_1", "before")]), true);
    assert.equal(providerToolRoundsCompactGroupKey([round("srv_1", "before")]), "m1");
    assert.equal(providerToolRoundsCompactGroupKey(undefined), undefined);
  });

  it("冷恢复按 part 顺序切轮，剩余本地工具与正文照旧", async () => {
    const history = createMessageHistory();
    await hydrateMessageHistoryFromSession({
      history,
      messages: [
        assistantMessage([
          textPart("p1", "before "),
          providerToolPart("p2", "srv_1"),
          textPart("p3", "after "),
          localToolPart("p4", "call_local"),
        ]),
      ],
    });
    const entries = history.toRuntimeEntries();
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "attachment" ? "attachment" : entry.message.role)),
      ["assistant", "tool", "assistant", "tool"],
    );
    assert.equal(entries[0]!.kind === "attachment" ? "" : entries[0]!.message.toolCalls?.[0]?.id, "srv_1");
    assert.equal(entries[0]!.kind === "attachment" ? "" : entries[0]!.compactGroupKey, "m1");
    assert.equal(entries[2]!.kind === "attachment" ? "" : entries[2]!.message.toolCalls?.[0]?.id, "call_local");
    assert.equal(entries[2]!.kind === "attachment" ? "" : entries[2]!.compactGroupKey, "m1");
    // 有服务端轮次时不把多轮合计 usage 挂到上下文估算锚点。
    assert.equal(entries[0]!.kind === "attachment" ? undefined : entries[0]!.tokens, undefined);
  });

  it("无服务端轮次时带合法 usage 的空 assistant 仍作为上下文估算锚点", async () => {
    const history = createMessageHistory();
    await hydrateMessageHistoryFromSession({
      history,
      messages: [assistantMessage([])],
    });
    const entries = history.toRuntimeEntries();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry!.kind === "attachment" ? undefined : entry!.message.role, "assistant");
    assert.equal(entry!.kind === "attachment" ? "" : entry!.message.content, "");
    // 持久化 usage 是 live 与冷恢复共同的估算锚点，不能被重新丢掉。
    assert.deepEqual(entry!.kind === "attachment" ? undefined : entry!.tokens?.input, 10);
  });

  it("compact 把同一持久化 assistant 拆出的多条 entry 算作一组", () => {
    const modifier = (entry: unknown) => entry as never;
    const entries = [
      { message: { content: "hi", role: "user" } },
      { compactGroupKey: "m1", message: { content: "a", role: "assistant" } },
      { message: { content: "r", role: "tool", toolCallId: "srv_1" } },
      { compactGroupKey: "m1", message: { content: "b", role: "assistant" } },
      { message: { content: "r2", role: "tool", toolCallId: "srv_2" } },
      { compactGroupKey: "m1", message: { content: "c", role: "assistant" } },
    ].map(modifier);
    const selection = selectCompactEntries({ entries, trigger: CompactTrigger.Auto });
    assert.equal(selection.totalGroups, 2);
  });
});
