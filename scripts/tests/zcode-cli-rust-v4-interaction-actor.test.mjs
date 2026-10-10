import assert from "node:assert/strict";
import test from "node:test";
import { createV4InteractionActor } from "../lib/zcode-cli-rust-v4-interaction-actor.mjs";

test("V4 actor handles delayed and duplicate interactions once", async () => {
  const answers = [];
  const actor = createV4InteractionActor({
    answer: async (...args) => answers.push(args),
  });
  const interaction = {
    interactionId: "interaction-1",
    kind: "permission",
    payload: { toolName: "Bash" },
  };

  await new Promise((resolve) => setTimeout(resolve, 5));
  actor.observe([interaction], "session-1");
  actor.observe([interaction, interaction], "session-1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(answers, [["session-1", "interaction-1", "Bash"]]);
});

test("observeFrame routes snapshot and patch interactions by conversation topic and deduplicates delivery", async () => {
  const answers = [];
  const actor = createV4InteractionActor({
    answer: async (...args) => answers.push(args),
  });
  const interaction = {
    interactionId: "topic-routed",
    kind: "permission",
    payload: { toolName: "Bash" },
  };
  const makeFrame = (kind) => ({
    method: "v4/conversation/frame",
    params: {
      frame: {
        topic: "conversation/session-topic",
        payload:
          kind === "snapshot"
            ? { kind, snapshot: { pendingInteractions: [interaction] } }
            : {
                kind,
                deltas: [{ op: "state.updated", patch: { pendingInteractions: [interaction] } }],
              },
      },
    },
  });

  actor.observeFrame(makeFrame("snapshot"));
  actor.observeFrame(makeFrame("patch"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(answers, [["session-topic", "topic-routed", "Bash"]]);
});

test("legacy permission claim cannot answer an interaction already owned by V4", async () => {
  const answers = [];
  const actor = createV4InteractionActor({ answer: async (...args) => answers.push(args) });
  actor.observe(
    [{ interactionId: "same-id", kind: "permission", payload: { toolName: "Read" } }],
    "session-a",
  );

  assert.equal(actor.claim("same-id", "session-a", "Read"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(answers, [["session-a", "same-id", "Read"]]);
});

test("V4 actor ignores non-fixture permissions and captures callback rejection", async () => {
  const failures = [];
  const actor = createV4InteractionActor({
    answer: async () => {
      throw new Error("fixture rejection");
    },
    onError: (error) => failures.push(error),
  });

  actor.observe(
    [
      { interactionId: "other", kind: "permission", payload: { toolName: "Write" } },
      { interactionId: "bash", kind: "permission", payload: { toolName: "Bash" } },
    ],
    "session-2",
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(actor.hasClaimed("other"), false);
  assert.equal(actor.hasClaimed("bash"), true);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /fixture rejection/);
});
