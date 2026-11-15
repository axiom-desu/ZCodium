// ============================================================
// 协议侧 TopicResourcePort：任务归属只来自工具上下文，取消走反向请求
// ============================================================
// 不变式：
//   1. 反向请求只携带 taskId + 索引选择器，没有 URL/路径/会话身份字段；
//   2. abort 触发 best-effort 取消，取消失败不能冒泡成未处理异常；
//   3. 读取结果必须通过协议 schema 校验，超出大小限制的字节不会被接受。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  zcodeProtocolMethods,
  zcodeTopicResourceReadResultSchema,
  type ZCodeProtocolTrace,
} from "@zcode/shared";
import { createProtocolTopicResourcePort } from "../src/zcode-protocol/topic-resource-port.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolClientRequestOptions,
} from "../src/zcode-protocol/server-types.js";

interface Call {
  method: string;
  params: unknown;
  options?: ZCodeProtocolClientRequestOptions;
}

function serverContext(
  respond: (call: Call) => Promise<unknown>,
  calls: Call[] = [],
): ZCodeProtocolAgentServerContext {
  return {
    requestClient: async (
      method: string,
      params: unknown,
      schema: { parse(value: unknown): unknown },
      options?: ZCodeProtocolClientRequestOptions,
    ) => {
      calls.push({ method, params, ...(options ? { options } : {}) });
      // 真实 requestClient 会用结果 schema 严格校验；这里保持同样语义。
      return schema.parse(await respond(calls.at(-1)!));
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

const TRACE: ZCodeProtocolTrace = { traceId: "trace_1" };

describe("createProtocolTopicResourcePort", () => {
  it("只发送任务归属与索引选择器", async () => {
    const calls: Call[] = [];
    const port = createProtocolTopicResourcePort(
      serverContext(async () => ({
        ref: "zcode-artifact://sess/upload",
        fileName: "notes.txt",
        mime: "text/plain",
        bytes: 12,
      }), calls),
    );
    const result = await port.read(
      { taskId: "sess_current", inputId: "input-a", messageId: "om_a", resourceIndex: 1 },
      { signal: new AbortController().signal, trace: { traceId: "trace_1" } as never },
    );
    assert.deepEqual(result, {
      ref: "zcode-artifact://sess/upload",
      fileName: "notes.txt",
      mime: "text/plain",
      bytes: 12,
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call!.method, zcodeProtocolMethods.topicResourceRead);
    const params = call!.params as Record<string, unknown>;
    assert.deepEqual(Object.keys(params).sort(), [
      "inputId",
      "messageId",
      "requestId",
      "resourceIndex",
      "taskId",
    ]);
    assert.equal(params.taskId, "sess_current");
    assert.equal(typeof params.requestId, "string");
    assert.equal(call!.options?.trace?.traceId, "trace_1");
    assert.equal(zcodeTopicResourceReadResultSchema.safeParse(result).success, true);
  });

  it("abort 时尽力通知 Host 取消，通知失败不吞掉原始错误", async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    const port = createProtocolTopicResourcePort(
      serverContext(async (call) => {
        if (call.method === zcodeProtocolMethods.topicResourceCancel) {
          throw new Error("connection closed");
        }
        // 读取挂起，等待 abort 事件触发取消请求。
        await new Promise((_resolve, reject) => {
          call.options?.signal?.addEventListener("abort", () =>
            reject(new Error("Topic resource read aborted")),
          );
        });
        return {};
      }, calls),
    );
    const pending = port.read(
      { taskId: "sess_current", messageId: "om_a", resourceIndex: 0 },
      { signal: controller.signal },
    );
    controller.abort(new Error("user cancelled"));
    await assert.rejects(pending, /aborted|invalid|Topic resource/i);
    const cancel = calls.find((call) => call.method === zcodeProtocolMethods.topicResourceCancel);
    assert.ok(cancel, "abort 必须发出取消请求");
    assert.deepEqual(Object.keys(cancel!.params as object).sort(), ["requestId", "taskId"]);
  });

  it("拒绝超出协议大小的结果", async () => {
    const port = createProtocolTopicResourcePort(
      serverContext(async () => ({
        ref: "zcode-artifact://sess/upload",
        fileName: "notes.txt",
        mime: "text/plain",
        bytes: 21 * 1024 * 1024,
      })),
    );
    await assert.rejects(
      port.read(
        { taskId: "sess_current", messageId: "om_a", resourceIndex: 0 },
        { signal: new AbortController().signal },
      ),
    );
  });

  it("trace 只投影协议字段，不把 core trace 原样发出去", async () => {
    const calls: Call[] = [];
    const port = createProtocolTopicResourcePort(
      serverContext(async () => ({
        ref: "zcode-artifact://sess/upload",
        fileName: "notes.txt",
        mime: "text/plain",
        bytes: 1,
      }), calls),
    );
    await port.read(
      { taskId: "sess_current", messageId: "om_a", resourceIndex: 0 },
      {
        signal: new AbortController().signal,
        trace: { traceId: "trace_1", sessionId: "sess_current" } as never,
      },
    );
    assert.deepEqual(calls[0]!.options?.trace, TRACE);
  });
});
