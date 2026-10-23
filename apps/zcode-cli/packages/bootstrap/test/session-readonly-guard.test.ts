import assert from "node:assert/strict";
import { it } from "node:test";
import type { SessionId, SessionTaskType } from "@zcode/contracts";

import { sendPrompt } from "../src/zcode-protocol/server-operations.js";
import { createGatewayTransportCodec } from "../src/zcode-protocol/v4-bridge-transport-codec.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

/**
 * 四种 kind 的输入准入矩阵：Agent/工作流驱动的子会话对用户只读
 * （`-32010` + `guard.subagentReadOnly`），selection_side_chat 仍可输入。
 * 修复根因：原先只拒绝 subagent_child，workflow_child / nested_workflow_child
 * 能从旧标签页或 legacy `session/send` 继续输入。
 */
const READONLY: SessionTaskType[] = ["subagent_child", "workflow_child", "nested_workflow_child"];

function record(taskType: SessionTaskType): ZCodeProtocolSessionRecord {
  return {
    app: { sessionId: `sess-${taskType}` },
    persistence: "immediate",
    taskType,
  } as unknown as ZCodeProtocolSessionRecord;
}

function context(taskType: SessionTaskType): ZCodeProtocolAgentServerContext {
  const sessionId = `sess-${taskType}`;
  return {
    deps: {},
    sessions: new Map([[sessionId, record(taskType)]]),
    logger: undefined,
  } as unknown as ZCodeProtocolAgentServerContext;
}

async function legacySendError(taskType: SessionTaskType): Promise<unknown> {
  try {
    await sendPrompt(context(taskType), { content: "hi", sessionId: `sess-${taskType}` });
    return null;
  } catch (error) {
    return error;
  }
}

it("legacy session/send 拒绝三种只读 kind，selection_side_chat 通过准入", async () => {
  for (const taskType of READONLY) {
    const error = await legacySendError(taskType);
    assert.ok(error instanceof Error, taskType);
    assert.equal((error as { code?: number }).code, -32010, taskType);
    assert.equal(
      (error as { data?: { reasonCode?: string } }).data?.reasonCode,
      "guard.subagentReadOnly",
      taskType,
    );
  }
  // selection_side_chat 不是只读：它继续走正常准入（这里因缺少 runtime 依赖而失败，
  // 但绝不能是只读守卫）。
  const error = await legacySendError("selection_side_chat");
  assert.notEqual(
    (error as { data?: { reasonCode?: string } } | null)?.data?.reasonCode,
    "guard.subagentReadOnly",
  );
});

function admitCodec(input: { resident?: SessionTaskType; persisted?: SessionTaskType }) {
  const sessionId = "sess-x";
  const codec = createGatewayTransportCodec({
    getNativeExecutor: () => ({ supports: () => false }),
    context: {
      deps: {
        sessionStore: {
          getSession: async (id: SessionId) =>
            String(id) === sessionId ? { taskType: input.persisted } : null,
        },
      },
      sessions: new Map(input.resident ? [[sessionId, record(input.resident)]] : []),
    } as unknown as ZCodeProtocolAgentServerContext,
  } as never);
  return () => codec.admitCommandInput?.({ sessionId, type: "sendText" } as never, {} as never);
}

it("v4 admitCommandInput 用同一只读集合，detached child 只读元数据也拒绝", async () => {
  for (const taskType of READONLY) {
    // 有 resident record 与只有持久元数据（detached child）两条路径都必须拒绝。
    for (const admit of [
      admitCodec({ resident: taskType, persisted: taskType }),
      admitCodec({ persisted: taskType }),
    ]) {
      await assert.rejects(
        async () => admit(),
        (error: Error & { reasonCode?: string }) => error.reasonCode === "guard.subagentReadOnly",
        taskType,
      );
    }
  }
  // selection_side_chat 不被只读集合拦截（后续准入由 coreHost 决定，这里没有实现）。
  await assert.rejects(
    async () => admitCodec({ resident: "selection_side_chat" })(),
    (error: Error & { reasonCode?: string }) => error.reasonCode !== "guard.subagentReadOnly",
  );
});
