import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionControlError } from "@zcode/session-control/contracts";
import { createAppControlRequestHandler } from "../src/app-control/rpc.js";
import type { AppControlTaskRow } from "../src/app-control/contract.js";
import { createAppControlService } from "../src/app-control/index.js";

/**
 * Rust native app-server 的 App 会话控制帧（R7b）在这里过 Host 的接受测试。
 *
 * 帧形状由 `apps/zcode-cli-rust/crates/core/src/app/app_control_tool.rs` 产出：
 * `{id: "rust-host-<id>", method: "appControl/<intent>", params: {callerSessionId, callId, input}}`。
 * Rust 不透传 `turnId`（无对等可信字段），身份只来自本轮会话与工具调用。
 */

const workspacePath = "/tmp/zcode-app-control-rust-frames";
const now = Date.now();
const tasks: AppControlTaskRow[] = [
  {
    taskId: "sess_a",
    hostId: "local",
    workspacePath,
    projectId: "p1",
    title: "第一章",
    status: "completed",
    updatedAt: now,
  },
];

function harness(options?: { service?: boolean; currentConnection?: boolean }) {
  const responses: unknown[] = [];
  const calls: string[] = [];
  const service = createAppControlService({
    sourceServerId: "local",
    projects: {
      async readTree() {
        return {
          projects: [{ id: "p1", hostId: "local", name: "小说", deleted: false }] as never,
          tasks: tasks as never,
        };
      },
      async readProjects() {
        return [{ id: "p1", hostId: "local", name: "小说", deleted: false }] as never;
      },
      async prepareSession() {
        return { workspacePath, additionalDirectories: [], projectId: "p1" } as never;
      },
    },
    tasks: {
      async getTaskMeta(params) {
        calls.push(`getTaskMeta:${params.taskId}`);
        return tasks.find((task) => task.taskId === params.taskId) ?? null;
      },
      async createTask() {
        return { taskId: "sess_new", workspacePath };
      },
      async sendPrompt(params) {
        calls.push(`sendPrompt:${params.content}`);
      },
      async stopGeneration() {
        return { applied: true };
      },
      async renameTask() {},
      async setTaskPinned() {},
      async archiveTask() {},
      async unarchiveTask() {},
    },
    agent: {
      async readSessionMessages() {
        return { messages: [] };
      },
      async readLiveSession() {
        return null;
      },
    },
  });
  const handler = createAppControlRequestHandler({
    client: {
      async respond(_id, result) {
        responses.push(result);
      },
      async respondError(_id, error) {
        responses.push(error);
      },
    },
    service: () => (options?.service === false ? undefined : service),
    bind: async ({ callerSessionId, callId }) => ({
      workspacePath,
      callerSessionId,
      callId,
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (options?.currentConnection === false) {
          throw new SessionControlError("forbidden", "App caller connection is no longer active");
        }
      },
      sourceServerId: "local",
      connectionId: "rust-loopback",
    }),
    onResponseError: (error) => {
      throw error;
    },
  });
  return { handler, responses, calls };
}

const rustFrame = (id: string, method: string, params: unknown) => ({
  id: `rust-host-${id}`,
  method,
  params,
});

test("Rust 只读帧：callerSessionId/callId/input 被接受并落到唯一服务", async () => {
  const { handler, responses, calls } = harness();
  assert.equal(
    handler.handle(
      rustFrame("1", "appControl/listSessions", {
        callerSessionId: "sess_a",
        callId: "call-1",
        input: { archived: "exclude" },
      }),
    ),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reply = responses[0] as { ok: boolean; result: { sessions: unknown[] } };
  assert.equal(reply.ok, true);
  assert.ok(Array.isArray(reply.result.sessions));
  assert.deepEqual(calls, []);
});

test("Rust 写意图帧：工具层注入的 requestId 在 input 内被接受", async () => {
  const { handler, responses, calls } = harness();
  assert.equal(
    handler.handle(
      rustFrame("2", "appControl/sendToSession", {
        callerSessionId: "sess_a",
        callId: "call-7",
        input: { sessionId: "sess_a", prompt: "继续", requestId: "req-3" },
      }),
    ),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((responses[0] as { ok: boolean }).ok, true);
  assert.ok(calls.includes("sendPrompt:继续"), JSON.stringify(calls));
});

test("伪 caller/未经 schema 的身份字段被 Host 以 -32602 拒绝，服务不被调用", async () => {
  const { handler, responses, calls } = harness();
  // 模型把 callerSessionId/callId 塞进 input：顶层身份仍是 Rust 注入的可信值，
  // Host 的 strict 输入 schema 是唯一否决点。
  assert.equal(
    handler.handle(
      rustFrame("3", "appControl/sendToSession", {
        callerSessionId: "sess_a",
        callId: "call-7",
        input: {
          sessionId: "sess_a",
          prompt: "继续",
          requestId: "call-7",
          callerSessionId: "sess_evil",
          callId: "call-evil",
        },
      }),
    ),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(responses[0], { code: -32602, message: "Invalid App control request params" });
  assert.deepEqual(calls, []);
});

test("缺少顶层身份字段的帧不是合法 App 控制请求", async () => {
  const { handler, responses } = harness();
  assert.equal(handler.handle(rustFrame("4", "appControl/listProjects", { input: {} })), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(responses[0], { code: -32602, message: "Invalid App control request params" });
});

test("Host 未装配 App control 时回 unavailable（Rust 得到 unknown 结论）", async () => {
  const { handler, responses } = harness({ service: false });
  assert.equal(
    handler.handle(
      rustFrame("5", "appControl/listProjects", {
        callerSessionId: "sess_a",
        callId: "call-1",
        input: {},
      }),
    ),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(responses[0], {
    ok: false,
    error: { code: "unavailable", message: "App control is unavailable on this Host" },
  });
});

test("Host 已切换连接代际时拒绝旧 Rust 请求", async () => {
  const { handler, responses, calls } = harness({ currentConnection: false });
  assert.equal(
    handler.handle(
      rustFrame("7", "appControl/sendToSession", {
        callerSessionId: "sess_a",
        callId: "call-stale",
        input: { sessionId: "sess_a", prompt: "不可执行", requestId: "req-stale" },
      }),
    ),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(responses[0], {
    ok: false,
    error: { code: "forbidden", message: "App caller connection is no longer active" },
  });
  assert.deepEqual(calls, []);
});

test("非 appControl 方法不被认领（Rust 帧不会误吞其它反向 RPC）", () => {
  const { handler } = harness();
  assert.equal(
    handler.handle({ id: "rust-host-6", method: "automation/pause", params: {} }),
    false,
  );
});
