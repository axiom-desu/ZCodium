import assert from "node:assert/strict";
import { it } from "node:test";
import type { CoreError, SessionId, SessionInfo } from "@zcode/contracts";
import { CoreErrorType } from "@zcode/contracts";

import { resumeFromStore } from "../src/runtime/methods/resume.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * 软删除的会话等同于不存在：resume 不能把它重新激活（否则已发布的 session.removed
 * 会被下一次冷恢复「复活」）。这里只实例化守卫所需的最小 runtime 面——通过守卫后的
 * 逻辑不参与本测试。
 */
async function resumeWith(session: SessionInfo | undefined): Promise<CoreError> {
  const runtime = {
    sessionId: "sess-1" as SessionId,
    sessionStore: { getSession: async () => session },
    rootTraceContext: { turnId: "t", traceId: "tr" },
  } as unknown as AgentRuntimeInternal;
  try {
    await resumeFromStore.call(runtime);
  } catch (error) {
    return error as CoreError;
  }
  assert.fail("deleted/missing session must not resume");
}

it("resume 把软删除行视为不存在", async () => {
  const error = await resumeWith({
    id: "sess-1",
    time: { created: 1, updated: 2, deleted: 1_000 },
  } as unknown as SessionInfo);
  assert.equal(error.type, CoreErrorType.SessionNotFound);
});

it("resume 对缺失行同样拒绝", async () => {
  const error = await resumeWith(undefined);
  assert.equal(error.type, CoreErrorType.SessionNotFound);
});
