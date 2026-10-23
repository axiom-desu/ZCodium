// ============================================================
// 执行级选型与接纳顺序
// ============================================================
// 三条不变式：
//   1. `selectionScope === "execution"` 的执行级选型**不改**会话默认（会话选择一个字节都不动）；
//   2. 会话选择在**接纳**时按 `admissionSeq` 前进——先跑的旧排队输入不能倒写较新的选择；
//   3. `ModelSelected.previousModelSelection` 取「上一次已发布」的值，不复读可能已被改写的会话值。
// 只搭 runtime 的那几样（选择读写、持久化、事件发射），不构造真 AgentRuntime。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model, ModelSelection, TurnInputIntentMetadata } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  acceptSubmissionModelSelection,
  applySubmissionExecutionState,
} from "../src/runtime/methods/turn-model.js";

function selection(modelId: string, reasoningLevel = "medium"): ModelSelection {
  return { modelId, options: { reasoningLevel }, providerId: "prov" };
}

function intent(
  seq: number,
  modelSelection: ModelSelection,
  sourceCommandId = `cmd-${seq}`,
): TurnInputIntentMetadata {
  return {
    admissionSeq: seq,
    admittedAt: seq,
    admittedDelivery: "queue",
    clientId: "cli",
    kind: "sendText",
    mode: undefined,
    modelSelection,
    queueItemId: `queue-${seq}`,
    requestedDelivery: "queue",
    sourceCommandId,
  };
}

interface Harness {
  runtime: AgentRuntimeInternal;
  current: () => ModelSelection | undefined;
  persisted: ModelSelection[];
  selected: Array<{ modelSelection: ModelSelection; previous?: ModelSelection | null }>;
}

function harness(initial?: ModelSelection): Harness {
  let sessionSelection = initial;
  const persisted: ModelSelection[] = [];
  const selected: Harness["selected"] = [];
  const runtime = {
    logger: { warn: () => {} },
    sessionId: "sess_selection",
    sessionPersisted: true,
    getSessionModelSelection: () =>
      sessionSelection === undefined ? undefined : structuredClone(sessionSelection),
    setSessionModelSelection: (next: ModelSelection | undefined) => {
      sessionSelection = next === undefined ? undefined : structuredClone(next);
    },
    sessionStore: {
      saveSessionEntry: async (entry: { data: ModelSelection }) => {
        persisted.push(structuredClone(entry.data));
      },
    },
    emitModelSelected: async (options: {
      modelSelection: ModelSelection;
      previousModelSelection?: ModelSelection | null;
    }) => {
      selected.push({
        modelSelection: structuredClone(options.modelSelection),
        previous: options.previousModelSelection ?? undefined,
      });
    },
  } as unknown as AgentRuntimeInternal;
  return {
    current: () => sessionSelection,
    persisted,
    runtime,
    selected,
  };
}

function fakeModel(modelSelection: ModelSelection): Model {
  return {
    displayName: modelSelection.modelId,
    modelId: modelSelection.modelId,
    optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } },
    options: { reasoningLevel: modelSelection.options?.reasoningLevel },
    properties: { contextWindow: 1000 },
    providerId: modelSelection.providerId,
  } as unknown as Model;
}

const trace = { sessionId: "sess_selection", spanId: "span", traceId: "trace" };

describe("执行级选型不改会话默认", () => {
  it("execution 作用域：不写会话选择、不持久化，仍建本轮模型", async () => {
    const initial = selection("session-model");
    const h = harness(initial);
    const declared = selection("execution-model", "high");
    const model = await applySubmissionExecutionState(
      h.runtime,
      intent(2, declared),
      trace,
      { selectionScope: "execution" },
      fakeModel(declared),
    );
    assert.deepEqual(h.current(), initial);
    assert.deepEqual(h.persisted, []);
    assert.deepEqual(h.selected, []);
    assert.equal(model?.modelId, "execution-model");
  });
});

describe("接纳顺序", () => {
  it("旧的排队输入不覆盖较新的选择：先接纳 2，再接纳 1 → 会话停在 2", async () => {
    const h = harness(selection("original"));
    await acceptSubmissionModelSelection(h.runtime, intent(2, selection("newer")), trace);
    const persisted = h.persisted.length;
    await acceptSubmissionModelSelection(h.runtime, intent(1, selection("older")), trace);
    assert.equal(h.current()?.modelId, "newer");
    assert.equal(h.persisted.length, persisted);
    assert.deepEqual(
      h.persisted.map((entry) => entry.modelId),
      ["newer"],
    );
  });

  it("同一 sourceCommandId 幂等：drain 时再接纳一次不重复写", async () => {
    const h = harness(selection("original"));
    const first = intent(3, selection("accepted"));
    await acceptSubmissionModelSelection(h.runtime, first, trace);
    await acceptSubmissionModelSelection(h.runtime, { ...first }, trace);
    assert.deepEqual(
      h.persisted.map((entry) => entry.modelId),
      ["accepted"],
    );
  });

  it("按接纳顺序串行持久化：后写不会落库在先写之前", async () => {
    const h = harness(selection("original"));
    const writes: string[] = [];
    h.runtime.sessionStore = {
      saveSessionEntry: async (entry: { data: ModelSelection }) => {
        // 让第一次写慢一点：若无串行，第二次会先落库。
        await new Promise((resolve) => setTimeout(resolve, 5));
        writes.push(entry.data.modelId);
      },
    } as unknown as AgentRuntimeInternal["sessionStore"];
    await Promise.all([
      acceptSubmissionModelSelection(h.runtime, intent(1, selection("first")), trace),
      acceptSubmissionModelSelection(h.runtime, intent(2, selection("second")), trace),
    ]);
    assert.deepEqual(writes, ["first", "second"]);
    assert.equal(h.current()?.modelId, "second");
  });

  it("会话行尚未创建时跳过持久化（ensureSessionPersisted 会写初始 entry），但选择已固定", async () => {
    const h = harness(selection("original"));
    (h.runtime as unknown as { sessionPersisted: boolean }).sessionPersisted = false;
    await acceptSubmissionModelSelection(h.runtime, intent(1, selection("accepted")), trace);
    assert.equal(h.current()?.modelId, "accepted");
    assert.deepEqual(h.persisted, []);
  });

  it("applySubmissionExecutionState 再接纳一次不回退（接纳已在命令入口发生）", async () => {
    const h = harness(selection("original"));
    await acceptSubmissionModelSelection(h.runtime, intent(1, selection("accepted")), trace);
    await applySubmissionExecutionState(
      h.runtime,
      intent(0, selection("stale-from-queue"), "cmd-0"),
      trace,
      undefined,
      fakeModel(selection("accepted")),
    );
    assert.equal(h.current()?.modelId, "accepted");
  });
});

describe("ModelSelected 的展示边界", () => {
  it("previous 取上一次已发布值：首个是接纳前的会话选择（不伪造 ∅→X），之后是上一次发布", async () => {
    const h = harness(selection("original"));
    const first = selection("model-a");
    await applySubmissionExecutionState(
      h.runtime,
      intent(1, first),
      trace,
      undefined,
      fakeModel(first),
    );
    const second = selection("model-b");
    await applySubmissionExecutionState(
      h.runtime,
      intent(2, second),
      trace,
      undefined,
      fakeModel(second),
    );
    assert.deepEqual(
      h.selected.map((entry) => ({
        model: entry.modelSelection.modelId,
        previous: entry.previous?.modelId,
      })),
      [
        { model: "model-a", previous: "original" },
        { model: "model-b", previous: "model-a" },
      ],
    );
    assert.equal(h.current()?.modelId, "model-b");
  });
});
