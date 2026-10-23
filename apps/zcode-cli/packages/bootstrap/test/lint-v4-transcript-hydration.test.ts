import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import {
  goalVerificationEntriesFromSessionEntries,
  synthesizeEventsFromMessages,
} from "../src/zcode-protocol-v4/transcript-hydration.js";
import { synthesizeEventsFromMessages as replaySynthesizeEventsFromMessages } from "../src/zcode-protocol-v4/replay.js";

function message(input: {
  id: string;
  role: "user" | "assistant";
  created: number;
  completed?: number;
  parts: unknown[];
}): MessageWithParts {
  const base = {
    id: input.id,
    sessionID: "session",
    role: input.role,
    time:
      input.role === "assistant"
        ? { created: input.created, completed: input.completed ?? input.created + 1 }
        : { created: input.created },
    ...(input.role === "assistant"
      ? { providerID: "provider", modelID: "model" }
      : { modelSelection: { providerId: "provider", modelId: "model" } }),
  };
  return { info: base, parts: input.parts } as unknown as MessageWithParts;
}

const messages = [
  message({
    id: "user-1",
    role: "user",
    created: 100,
    parts: [{ id: "part-user", type: "text", text: "hello" }],
  }),
  message({
    id: "assistant-1",
    role: "assistant",
    created: 110,
    completed: 120,
    parts: [{ id: "part-assistant", type: "text", text: "world" }],
  }),
];

test("cold transcript synthesis keeps the original public exports", () => {
  assert.equal(replaySynthesizeEventsFromMessages, synthesizeEventsFromMessages);
  assert.equal(typeof goalVerificationEntriesFromSessionEntries, "function");
});

test("cold transcript synthesis emits one ordered turn that reduces to the same snapshot", () => {
  const events = synthesizeEventsFromMessages(messages, {
    sessionId: "session",
    contextWindow: 1_000,
  });

  assert.deepEqual(
    events.map((event) => event.type),
    [
      SessionEventType.SessionCreated,
      SessionEventType.ModelSelected,
      SessionEventType.TurnStarted,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelComplete,
      SessionEventType.TurnComplete,
    ],
  );
  assert.deepEqual(
    events.map((event) => event.sequenceNumber),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  const started = events[2]!;
  assert.equal((started.payload as { messageId?: string }).messageId, "user-1");
  assert.equal((started.payload as { input?: string }).input, "hello");

  const first = new ProductProjection("session", "epoch");
  for (const event of events) first.applyEvent(event);
  const second = new ProductProjection("session", "epoch");
  for (const event of synthesizeEventsFromMessages(messages, {
    sessionId: "session",
    contextWindow: 1_000,
  })) {
    second.applyEvent(event);
  }

  assert.deepEqual(first.getSnapshot().rows.window, second.getSnapshot().rows.window);
  const rows = first.getSnapshot().rows.window;
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["turnHeader", "userInput", "assistantText"],
  );
  assert.equal(rows[1]?.kind === "userInput" ? rows[1].text : null, "hello");
  assert.equal(rows[2]?.kind === "assistantText" ? rows[2].text : null, "world");
  assert.equal(first.getSnapshot().seq, events.at(-1)?.sequenceNumber);
});

test("legacy goal verification entries are parsed, ordered and deduplicated by key", () => {
  const entries = goalVerificationEntriesFromSessionEntries([
    {
      data: {
        payload: {
          targetId: "target",
          verificationId: "verification",
          goalIteration: 1,
          status: "started",
        },
        sequenceNumber: 2,
      },
      time: { created: 20 },
    },
    {
      data: {
        payload: {
          targetId: "target",
          verificationId: "verification",
          goalIteration: 1,
          status: "completed",
          anchorAssistantMessageId: "assistant-1",
        },
        sequenceNumber: 1,
      },
      time: { created: 10 },
    },
    {
      data: { payload: { targetId: "missing-verification-id" } },
      time: { created: 30 },
    },
  ]);

  assert.deepEqual(
    entries.map((entry) => [entry.payload.targetId, entry.payload.status, entry.sequenceNumber]),
    [
      ["target", "completed", 1],
      ["target", "started", 2],
    ],
  );
});
