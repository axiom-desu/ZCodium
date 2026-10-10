import assert from "node:assert/strict";
import test from "node:test";
import { hasAssistantTextEvidence } from "../lib/zcode-cli-rust-stream-evidence.mjs";

const frame = (sessionId, ...deltas) => ({
  params: { frame: { topic: `conversation/${sessionId}`, payload: { sessionId, deltas } } },
});

test("input row delta is not evidence that assistant text streamed", () => {
  const frames = [
    frame("session-a", {
      op: "row.appended",
      row: { rowId: "input-1", turnId: "turn-1", kind: "userInput", text: "prompt" },
    }),
    frame("session-a", {
      op: "row.delta",
      rowId: "input-1",
      path: "inputText",
      append: "more",
    }),
  ];
  assert.equal(hasAssistantTextEvidence(frames, 0, "session-a"), false);
});

test("only non-empty assistant text for this session and turn is evidence", () => {
  const frames = [
    frame("other", {
      op: "row.appended",
      row: { rowId: "other-row", turnId: "turn-1", kind: "assistantText", text: "wrong session" },
    }),
    frame("session-a", {
      op: "row.appended",
      row: { rowId: "assistant-1", turnId: "turn-2", kind: "assistantText", text: "" },
    }),
    frame("session-a", {
      op: "row.delta",
      rowId: "assistant-1",
      path: "text",
      append: "first token",
    }),
  ];
  assert.equal(hasAssistantTextEvidence(frames, 0, "session-a"), true);
});
