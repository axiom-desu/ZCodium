import { describe, expect, it } from "vitest";
import type { CommandAck, CommandType } from "@zcode/shared/zcode-protocol-v4";
import { startDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";

/**
 * 预热 dispose 的协议事实：只有「已建、从未 promote」的 draft 才发 deleteSession。
 * Host 侧预留释放（project-storage receipt）只以这条 CLI 关闭回执为触发点，
 * 所以这里锁住的是释放链路的上半段，不是 UI 可见行为。
 */
const WORKSPACE = "/workspace/app";
const SESSION = "session_prewarmed";

function accepted(commandId: string, sessionId?: string): CommandAck {
  return {
    commandId,
    status: "accepted",
    revisionAtDecision: 0,
    ...(sessionId ? { result: { type: "createSession" as const, sessionId } } : {}),
  };
}

function harness() {
  const calls: Array<{ type: CommandType; sessionId: string | null }> = [];
  let resolveCreate: ((ack: CommandAck) => void) | null = null;
  const dispatchCommand = (
    type: CommandType,
    _payload: Record<string, unknown>,
    targetSessionId: string | null,
  ): Promise<CommandAck> => {
    calls.push({ type, sessionId: targetSessionId });
    if (type === "createSession") {
      return new Promise<CommandAck>((resolve) => {
        resolveCreate = resolve;
      });
    }
    return Promise.resolve(accepted(`ack-${type}`));
  };
  const ready: string[] = [];
  const controller = startDraftSessionPrewarm({
    workspaceKey: WORKSPACE,
    dispatchCommand: dispatchCommand as never,
    onReady: (sessionId) => ready.push(sessionId),
    createContext: { projectId: "project-a" },
  });
  return {
    calls,
    ready,
    controller,
    settleCreate: () => resolveCreate?.(accepted("cmd-create", SESSION)),
  };
}

describe("draft prewarm dispose", () => {
  it("未 promote 的 dispose 只删除自己建出的 draft 会话", async () => {
    const { calls, ready, controller, settleCreate } = harness();
    settleCreate();
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toEqual([SESSION]);
    expect(calls.filter((call) => call.type === "deleteSession")).toEqual([]);

    controller.dispose();
    await Promise.resolve();
    expect(calls.filter((call) => call.type === "deleteSession")).toEqual([
      { type: "deleteSession", sessionId: SESSION },
    ]);
  });

  it("createSession 仍在飞时 dispose：ACK 到达后就地删除，不遗留内存会话", async () => {
    const { calls, controller, settleCreate } = harness();
    controller.dispose();
    settleCreate();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((call) => call.type === "deleteSession")).toEqual([
      { type: "deleteSession", sessionId: SESSION },
    ]);
  });

  it("已 promote / promotion pending 的会话不因 dispose 被删除", async () => {
    const { calls, controller, settleCreate } = harness();
    settleCreate();
    await Promise.resolve();
    await Promise.resolve();

    controller.markPromotionPending();
    controller.dispose();
    await Promise.resolve();
    expect(calls.filter((call) => call.type === "deleteSession")).toEqual([]);
  });

  it("promoted 后即使再 dispose 也不发 deleteSession（已接受任务由 CLI 事实收口）", async () => {
    const { calls, controller, settleCreate } = harness();
    settleCreate();
    await Promise.resolve();
    await Promise.resolve();

    controller.markPromoted();
    controller.dispose();
    controller.dispose();
    await Promise.resolve();
    expect(calls.filter((call) => call.type === "deleteSession")).toEqual([]);
  });
});
