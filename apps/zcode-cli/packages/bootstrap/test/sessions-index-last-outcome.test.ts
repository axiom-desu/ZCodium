import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  ConversationSnapshot,
  SessionPhase,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { sessionSummarySchema } from "@zcode/shared/zcode-protocol-v4";

import { SessionsIndexProjection } from "../src/zcode-protocol-v4/sessions-index-projection.js";

/**
 * sessions-index 的 lastOutcome 是持久「上次结果」，不是实时 phase：
 * 冷种子的持久值必须保留，live 只有从非终态翻到终态时才更新；旧行缺字段不凭空补。
 */
function snapshot(phase: SessionPhase, title = "task"): ConversationSnapshot {
  return {
    sessionId: "s1",
    meta: { title, titleSource: "default" },
    control: {
      phase,
      sessionEnded:
        phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error",
    },
    rows: { window: [] },
    backgroundWorks: [],
    pendingInteractions: [],
    goal: null,
  } as unknown as ConversationSnapshot;
}

function summary(phase: SessionPhase, lastOutcome?: SessionSummary["lastOutcome"]): SessionSummary {
  return {
    sessionId: "s1",
    workspaceId: "ws",
    title: "task",
    titleSource: "default",
    phase,
    sessionEnded: true,
    hasBackgroundWork: false,
    ...(lastOutcome ? { lastOutcome } : {}),
    lastActivityAt: 10,
    createdAt: 1,
  };
}

const extra = { createdAt: 1, lastActivityAt: 10 };

it("schema 接受三种 lastOutcome，未知值仍被 strict 校验拒绝", () => {
  for (const lastOutcome of ["completed", "error", "interrupted"] as const) {
    assert.equal(
      sessionSummarySchema.parse(summary("error", lastOutcome)).lastOutcome,
      lastOutcome,
    );
  }
  assert.equal(sessionSummarySchema.parse(summary("running")).lastOutcome, undefined);
  assert.throws(() =>
    sessionSummarySchema.parse({ ...summary("running"), lastOutcome: "success" }),
  );
});

it("冷种子持久 lastOutcome 不被 live 的非终态快照清掉", () => {
  const projection = new SessionsIndexProjection("ws", "epoch");
  projection.seed(summary("error", "error"));
  const deltas = projection.upsertFromConversation(snapshot("running"), extra);
  const upserted = deltas.find((delta) => delta.op === "session.upserted");
  assert.ok(upserted);
  // 新 run 在跑时 DB 里仍是上一轮结果，摘要必须保留它。
  assert.equal(upserted.session.lastOutcome, "error");
});

it("live 从非终态翻到终态的同一映射写入 lastOutcome", () => {
  for (const [phase, expected] of [
    ["completedSuccess", "completed"],
    ["completedInterrupted", "interrupted"],
    ["error", "error"],
  ] as const) {
    const projection = new SessionsIndexProjection("ws", "epoch");
    projection.seed(summary("completedSuccess", "completed"));
    projection.upsertFromConversation(snapshot("running"), extra);
    const deltas = projection.upsertFromConversation(snapshot(phase), extra);
    const upserted = deltas.find((delta) => delta.op === "session.upserted");
    assert.ok(upserted, phase);
    assert.equal(upserted.session.lastOutcome, expected);
  }
});

it("旧行缺 lastOutcome 时终态基线不伪造成 completed", () => {
  const projection = new SessionsIndexProjection("ws", "epoch");
  projection.seed(summary("completedSuccess"));
  const deltas = projection.upsertFromConversation(snapshot("completedSuccess"), extra);
  assert.deepEqual(deltas, []);
  assert.equal(projection.getSnapshot().sessions[0]?.lastOutcome, undefined);
});
