import assert from "node:assert/strict";
import { test } from "node:test";
import { sendHostForkAssistant } from "../src/zcode-agent/forkAssistantCommand.js";

const workspace = { workspacePath: "/tmp/zcode-fork-command" };

function capture() {
  const sent: unknown[] = [];
  const send = async (params: unknown) => {
    sent.push(params);
    return { status: "accepted", result: { type: "forkAssistant", sessionId: "sess_child" } };
  };
  return { sent, send: send as never };
}

test("fork command carries the real target, CAS snapshot and idempotent identity", async () => {
  const { sent, send } = capture();
  const result = await sendHostForkAssistant(send, {
    ...workspace,
    sessionId: "sess_parent",
    target: { rowId: 10, entityId: "msg_assistant" },
    baseRevision: 7,
    baseLogEpoch: "epoch-1",
    commandId: "app-control-abc",
    clientId: "sess_parent",
  });
  assert.deepEqual(result, { status: "created", sessionId: "sess_child" });
  const params = sent[0] as {
    workspacePath: string;
    envelope: {
      type: string;
      sessionId: string;
      commandId: string;
      clientId: string;
      baseRevision: number;
      baseLogEpoch: string;
      payload: { target: { rowId: number; entityId: string } };
    };
  };
  assert.equal(params.workspacePath, workspace.workspacePath);
  assert.equal(params.envelope.type, "forkAssistant");
  assert.equal(params.envelope.sessionId, "sess_parent");
  assert.equal(params.envelope.commandId, "app-control-abc");
  assert.equal(params.envelope.clientId, "sess_parent");
  assert.equal(params.envelope.baseRevision, 7);
  assert.equal(params.envelope.baseLogEpoch, "epoch-1");
  assert.deepEqual(params.envelope.payload.target, { rowId: 10, entityId: "msg_assistant" });
});

test("explicit CLI rejection stays rejected; missing result stays unknown", async () => {
  const rejected = await sendHostForkAssistant(
    (async () => ({ status: "stale", reasonCode: "proto.staleTarget" })) as never,
    {
      ...workspace,
      sessionId: "sess_parent",
      target: { rowId: 1, entityId: "msg" },
      baseRevision: 1,
      baseLogEpoch: "epoch",
    },
  );
  assert.deepEqual(rejected, { status: "rejected", reason: "proto.staleTarget" });

  const unknown = await sendHostForkAssistant(
    (async () => ({ status: "accepted", result: undefined })) as never,
    {
      ...workspace,
      sessionId: "sess_parent",
      target: { rowId: 1, entityId: "msg" },
      baseRevision: 1,
      baseLogEpoch: "epoch",
    },
  );
  assert.equal(unknown.status, "unknown");
});

test("old runtime method-not-found is explicitly unsupported; other transport errors still throw", async () => {
  const unsupported = await sendHostForkAssistant(
    (async () => {
      throw Object.assign(new Error("Method not found: v4/command"), { code: -32601 });
    }) as never,
    {
      ...workspace,
      sessionId: "sess_parent",
      target: { rowId: 1, entityId: "msg" },
      baseRevision: 1,
      baseLogEpoch: "epoch",
    },
  );
  assert.equal(unsupported.status, "unsupported");
  await assert.rejects(
    sendHostForkAssistant(
      (async () => {
        throw new Error("socket closed");
      }) as never,
      {
        ...workspace,
        sessionId: "sess_parent",
        target: { rowId: 1, entityId: "msg" },
        baseRevision: 1,
        baseLogEpoch: "epoch",
      },
    ),
    /socket closed/,
  );
});
