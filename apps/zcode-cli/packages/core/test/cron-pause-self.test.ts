// ============================================================
// F14 CronPauseSelf：只暂停"触发本轮的那条 automation"
// ============================================================
// 不变式：
//   1. 目标身份只来自执行器注入的 automationId（Host 准入），不接受任何模型输入；
//   2. 没有身份就没有可暂停的任务 → PermissionDenied，且不调用端口；
//   3. 输入 schema 是空严格对象：模型塞不进 id，也不能改定义；
//   4. 端口缺 pause 能力 → 明确报能力不支持，不返回假成功；
//   5. 非 automation 轮在 provider 边界隐藏，真执行轮可见。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoreErrorType, isCoreError, type AutomationPort } from "@zcode/contracts";

import { cronPauseSelfToolEntry } from "../src/tool/handlers/cron-pause-self.js";
import { builtInTools } from "../src/tool/handlers/index.js";
import type { RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";
import { buildTurnDisallowedTools } from "../src/runtime/methods/turn-tool-visibility.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

function context(partial: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "s1" as ToolExecutionContext["sessionId"],
    toolCallId: "call_1",
    traceId: "t1" as ToolExecutionContext["traceId"],
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    ...partial,
  } as unknown as ToolExecutionContext;
}

function automationPort(overrides: Partial<AutomationPort> = {}): AutomationPort {
  return {
    create: () => {
      throw new Error("not used");
    },
    delete: async () => false,
    list: async () => [],
    update: () => {
      throw new Error("not used");
    },
    ...overrides,
  };
}

function stateOf(partial: Record<string, unknown>): RegularTurnLoopState {
  return {
    toolDisallowlist: [],
    turnTraceContext: { traceId: "t1" },
    ...partial,
  } as unknown as RegularTurnLoopState;
}

describe("CronPauseSelf", () => {
  it("没有 automationId 时拒绝，且不碰端口", async () => {
    let called = 0;
    const port = automationPort({
      pause: async () => {
        called++;
        return true;
      },
    });
    await assert.rejects(
      () => cronPauseSelfToolEntry.handler({}, context({ automationPort: port })),
      (error: unknown) => isCoreError(error) && error.type === CoreErrorType.PermissionDenied,
    );
    assert.equal(called, 0);
  });

  it("只暂停执行器注入的 id，模型塞不进目标", async () => {
    const paused: string[] = [];
    const port = automationPort({
      pause: async (input) => {
        paused.push(input.id);
        return true;
      },
    });
    const output = (await cronPauseSelfToolEntry.handler(
      {},
      context({ automationId: "auto-1", automationPort: port }),
    )) as { id: string; paused: boolean; message: string };
    assert.deepEqual(paused, ["auto-1"]);
    assert.equal(output.id, "auto-1");
    assert.equal(output.paused, true);

    // 空严格 schema：模型不能指定目标。
    await assert.rejects(
      () =>
        cronPauseSelfToolEntry.handler(
          { id: "auto-2" },
          context({ automationId: "auto-1", automationPort: port }),
        ),
      /unrecognized key|Unrecognized/i,
    );
    assert.deepEqual(paused, ["auto-1"]);
  });

  it("任务已不活跃时如实回报未改变", async () => {
    const port = automationPort({ pause: async () => false });
    const output = (await cronPauseSelfToolEntry.handler(
      {},
      context({ automationId: "auto-1", automationPort: port }),
    )) as { message: string; paused: boolean };
    assert.equal(output.paused, false);
    assert.match(output.message, /nothing changed/);
  });

  it("端口缺 pause 能力时明确报能力不支持", async () => {
    await assert.rejects(
      () => cronPauseSelfToolEntry.handler({}, context({ automationId: "auto-1", automationPort: automationPort() })),
      (error: unknown) => isCoreError(error) && error.type === CoreErrorType.ConfigurationError,
    );
  });

  it("provider 边界：非执行轮隐藏，执行轮可见", () => {
    const withoutId = buildTurnDisallowedTools(stateOf({}));
    assert.equal(withoutId?.has("CronPauseSelf"), true);
    const withId = buildTurnDisallowedTools(stateOf({ automationId: "auto-1" }));
    assert.equal(withId?.has("CronPauseSelf") ?? false, false);
    // 执行轮仍隐藏定义管理工具，自暂停不在其中。
    assert.equal(withId?.has("CronCreate"), true);
  });

  it("注册进内置工具表（automation 端口存在才注册）", () => {
    assert.ok(builtInTools.some((entry) => entry.metadata.name === "CronPauseSelf"));
  });
});
