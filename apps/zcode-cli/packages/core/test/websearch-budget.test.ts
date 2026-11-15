// ============================================================
// F13 WebSearch per-ask 预算：耗尽即不发内部模型请求
// ============================================================
// 不变式：
//   1. 扣减发生在能力校验之后、发请求之前：预算耗尽时一次 provider 请求都不发；
//   2. 耗尽回业务失败（errorCode=2），文案原样来自端口，输出 schema 不承载拒绝；
//   3. 端口缺席 = 无预算（主会话、Agent 子代理），行为与引入预算前一致。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
  type Model,
  type WebSearchBudgetCharge,
  type WorkflowWebSearchBudgetPort,
} from "@zcode/contracts";

import { webSearchToolEntry } from "../src/tool/handlers/websearch.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const EXHAUSTED: WebSearchBudgetCharge = {
  kind: "exhausted",
  limit: 3,
  message: "Search budget exhausted: at most 3 WebSearch calls per task.",
};

function searchModel(streams: { count: number }): Model {
  return {
    modelId: "m",
    optionSpecs: {
      maxOutputTokens: { max: 8_000 },
      reasoningLevel: { values: ["none"] },
    },
    properties: {
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      supportsNativeWebSearch: true,
      supportsReasoning: false,
      supportsToolCall: true,
      supportsVision: false,
    },
    providerId: "p",
    streamText: () => {
      streams.count++;
      // 预算路径不该走到这里；真的走到了就给一个空流，让断言看到调用次数。
      return (async function* empty() {})();
    },
  } as unknown as Model;
}

function context(
  model: Model,
  webSearchBudget?: WorkflowWebSearchBudgetPort,
): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    model,
    sessionId: "s1" as ToolExecutionContext["sessionId"],
    toolCallId: "call_1",
    traceId: "t1" as ToolExecutionContext["traceId"],
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    ...(webSearchBudget === undefined ? {} : { webSearchBudget }),
  } as unknown as ToolExecutionContext;
}

describe("WebSearch 预算", () => {
  it("耗尽时回业务失败，且不发任何内部请求", async () => {
    const streams = { count: 0 };
    const charges = { count: 0 };
    const budget: WorkflowWebSearchBudgetPort = {
      charge: () => {
        charges.count++;
        return EXHAUSTED;
      },
    };
    const output = await webSearchToolEntry.handler(
      { query: "anything" },
      context(searchModel(streams), budget),
    );
    assert.deepEqual(output, {
      result: false,
      errorCode: WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE,
      message: EXHAUSTED.kind === "exhausted" ? EXHAUSTED.message : "",
    });
    assert.equal(charges.count, 1);
    assert.equal(streams.count, 0);
  });

  it("未耗尽时照常扣减并继续请求", async () => {
    const streams = { count: 0 };
    const charges = { count: 0 };
    const budget: WorkflowWebSearchBudgetPort = {
      charge: () => {
        charges.count++;
        return { kind: "charged" };
      },
    };
    // 空流不产生搜索结果，handler 可能报错也可能返回空结果；这里只验证请求确实发出去了。
    await webSearchToolEntry
      .handler({ query: "q" }, context(searchModel(streams), budget))
      .catch(() => undefined);
    assert.equal(charges.count, 1);
    assert.equal(streams.count, 1);
  });

  it("端口缺席即无预算：直接请求，不产生隐形拒绝", async () => {
    const streams = { count: 0 };
    await webSearchToolEntry
      .handler({ query: "q" }, context(searchModel(streams)))
      .catch(() => undefined);
    assert.equal(streams.count, 1);
  });
});
