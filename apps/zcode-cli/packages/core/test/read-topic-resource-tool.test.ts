// ============================================================
// ReadTopicResource：只读当前任务已接纳话题资源
// ============================================================
// 不变式：
//   1. 模型输入只有 inputId/messageId/index；URL、路径、会话身份一律被 strict schema 拒绝；
//   2. 任务归属只来自工具上下文 sessionId，端口收到的 taskId 不能是模型提供的值；
//   3. inputId 存在时必须出现在本任务已持久化的输入事实里；
//   4. 端口缺失/未接纳/大小或编码不符/取消都抛错，不回退到其他来源。

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import type {
  ToolArtifactStorePort,
  ToolBinaryArtifactWriteRequest,
  ToolArtifactReadRequest,
  ToolArtifactReadResult,
  ToolArtifactWriteResult,
  TopicResourcePort,
} from "@zcode/contracts";
import {
  READ_TOPIC_RESOURCE_TOOL_NAME,
  ReadTopicResourceInputSchema,
} from "../src/tool/topic-resource/contract.js";
import { readTopicResourceToolEntry } from "../src/tool/handlers/read-topic-resource.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const PAYLOAD = Buffer.from("topic-resource-bytes");

/** 只实现本工具用到的两条 artifact 通道；其余缺口直接抛错。 */
class FakeArtifactStore implements Partial<ToolArtifactStorePort> {
  written?: ToolBinaryArtifactWriteRequest;

  constructor(private readonly content: string) {}

  async readToolResultArtifact(
    _request: ToolArtifactReadRequest,
    _options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult> {
    return { uri: "zcode-artifact://session/a", content: this.content, contentType: "text/plain", bytes: this.content.length };
  }

  async writeToolResultBinaryArtifact(
    request: ToolBinaryArtifactWriteRequest,
  ): Promise<ToolArtifactWriteResult> {
    this.written = request;
    return {
      id: "binary",
      uri: "zcode-artifact://session/binary",
      path: "/tmp/artifacts/topic-resource.txt",
      bytes: request.content.byteLength,
      contentType: request.contentType,
      createdAt: new Date(),
    };
  }
}

function dataUrl(bytes: Buffer, mime = "text/plain"): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function userMessage(sessionId: string, sourceCommandId: string, metadata: "canonical" | "legacy") {
  return {
    info: {
      id: `msg-${randomUUID()}`,
      sessionID: sessionId,
      role: "user" as const,
      synthetic: false,
      metadata:
        metadata === "canonical"
          ? { conversationInputIntent: { sourceCommandId } }
          : { inputIntent: { sourceCommandId } },
    },
    parts: [],
  };
}

function context(options: {
  sessionId: string;
  messages?: ReturnType<typeof userMessage>[];
  port?: TopicResourcePort;
  artifactStore?: FakeArtifactStore;
  signal?: AbortSignal;
}): ToolExecutionContext {
  return {
    abortSignal: options.signal ?? new AbortController().signal,
    sessionId: options.sessionId,
    toolCallId: "call_1",
    traceId: "trace_1",
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    ...(options.port ? { topicResourcePort: options.port } : {}),
    ...(options.artifactStore ? { artifactStore: options.artifactStore } : {}),
    sessionStore: {
      messages: async () => options.messages ?? [],
    },
  } as unknown as ToolExecutionContext;
}

function port(result: { ref: string; fileName: string; mime: string; bytes: number }): TopicResourcePort {
  const calls: unknown[] = [];
  return {
    read: async (request) => {
      calls.push(request);
      return result;
    },
    // 只为断言方便挂上调用记录，不进入端口类型。
    ...({ calls } as object),
  };
}

describe("ReadTopicResource", () => {
  it("strict schema 拒绝 URL/路径/会话身份，只接受索引选择器", () => {
    assert.equal(ReadTopicResourceInputSchema.safeParse({ messageId: "om_a" }).success, true);
    assert.equal(
      ReadTopicResourceInputSchema.safeParse({ inputId: "i", messageId: "om_a", index: 1 }).success,
      true,
    );
    for (const payload of [
      { messageId: "om_a", url: "https://evil.example/x" },
      { messageId: "om_a", path: "/etc/passwd" },
      { messageId: "om_a", sessionId: "sess_other" },
      { messageId: "om_a", chatId: "chat_other" },
      { messageId: "" },
      { messageId: "om_a", index: -1 },
    ]) {
      assert.equal(ReadTopicResourceInputSchema.safeParse(payload).success, false, JSON.stringify(payload));
    }
  });

  it("声明会话级延迟副作用而不是只读", () => {
    assert.equal(readTopicResourceToolEntry.metadata.name, READ_TOPIC_RESOURCE_TOOL_NAME);
    assert.equal(readTopicResourceToolEntry.metadata.shouldDefer, true);
    assert.equal(readTopicResourceToolEntry.metadata.readOnly, false);
    assert.equal(readTopicResourceToolEntry.metadata.sideEffectScope, "session");
    assert.equal(readTopicResourceToolEntry.timeout?.defaultMs, 300_000);
  });

  it("用当前任务归属读取并经受管 artifact 物化", async () => {
    const sessionId = "sess_current";
    const store = new FakeArtifactStore(dataUrl(PAYLOAD));
    const topicPort = port({
      ref: "zcode-artifact://sess_current/upload",
      fileName: "notes.txt",
      mime: "text/plain",
      bytes: PAYLOAD.byteLength,
    });
    const output = await readTopicResourceToolEntry.handler(
      { inputId: "input-a", messageId: "om_a", index: 0 },
      context({
        sessionId,
        messages: [userMessage(sessionId, "input-a", "canonical")],
        port: topicPort,
        artifactStore: store,
      }),
    );
    assert.deepEqual(output, {
      status: "success",
      path: "/tmp/artifacts/topic-resource.txt",
      fileName: "notes.txt",
      mime: "text/plain",
      bytes: PAYLOAD.byteLength,
      messageId: "om_a",
      index: 0,
    });
    assert.deepEqual((topicPort as unknown as { calls: unknown[] }).calls, [
      { taskId: sessionId, inputId: "input-a", messageId: "om_a", resourceIndex: 0 },
    ]);
    assert.equal(store.written?.toolName, READ_TOPIC_RESOURCE_TOOL_NAME);
    assert.equal(store.written?.retention, "session");
    assert.equal(store.written?.extension, "txt");
    assert.equal(
      createHash("sha256").update(Buffer.from(store.written!.content)).digest("hex"),
      createHash("sha256").update(PAYLOAD).digest("hex"),
    );
  });

  it("inputId 必须属于本任务已持久化的输入事实", async () => {
    const sessionId = "sess_current";
    await assert.rejects(
      readTopicResourceToolEntry.handler(
        { inputId: "input-from-other-task", messageId: "om_a" },
        context({
          sessionId,
          messages: [userMessage(sessionId, "input-a", "canonical")],
          port: port({
            ref: "zcode-artifact://sess_current/upload",
            fileName: "notes.txt",
            mime: "text/plain",
            bytes: PAYLOAD.byteLength,
          }),
          artifactStore: new FakeArtifactStore(dataUrl(PAYLOAD)),
        }),
      ),
      /not indexed in the selected history snapshot/,
    );
  });

  it("旧会话可用 legacy inputIntent 证明 inputId", async () => {
    const sessionId = "sess_legacy";
    const output = await readTopicResourceToolEntry.handler(
      { inputId: "input-legacy", messageId: "om_a" },
      context({
        sessionId,
        messages: [userMessage(sessionId, "input-legacy", "legacy")],
        port: port({
          ref: "zcode-artifact://sess_legacy/upload",
          fileName: "notes.txt",
          mime: "text/plain",
          bytes: PAYLOAD.byteLength,
        }),
        artifactStore: new FakeArtifactStore(dataUrl(PAYLOAD)),
      }),
    );
    assert.equal(output.index, 0);
  });

  it("没有 Host 端口即不可用，不回退到本地路径或 URL", async () => {
    await assert.rejects(
      readTopicResourceToolEntry.handler(
        { messageId: "om_a" },
        context({ sessionId: "sess_current", artifactStore: new FakeArtifactStore(dataUrl(PAYLOAD)) }),
      ),
      /Topic attachment retrieval is unavailable/,
    );
  });

  it("拒绝大小/编码不一致的寄存内容", async () => {
    const sessionId = "sess_current";
    const mismatched = port({
      ref: "zcode-artifact://sess_current/upload",
      fileName: "notes.txt",
      mime: "text/plain",
      bytes: PAYLOAD.byteLength + 1,
    });
    await assert.rejects(
      readTopicResourceToolEntry.handler(
        { messageId: "om_a" },
        context({ sessionId, port: mismatched, artifactStore: new FakeArtifactStore(dataUrl(PAYLOAD)) }),
      ),
      /size or encoding mismatch/,
    );
    const wrongMime = port({
      ref: "zcode-artifact://sess_current/upload",
      fileName: "notes.txt",
      mime: "image/png",
      bytes: PAYLOAD.byteLength,
    });
    await assert.rejects(
      readTopicResourceToolEntry.handler(
        { messageId: "om_a" },
        context({ sessionId, port: wrongMime, artifactStore: new FakeArtifactStore(dataUrl(PAYLOAD)) }),
      ),
      /Invalid topic attachment artifact/,
    );
  });

  it("取消后不再物化 artifact", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const store = new FakeArtifactStore(dataUrl(PAYLOAD));
    await assert.rejects(
      readTopicResourceToolEntry.handler(
        { messageId: "om_a" },
        context({
          sessionId: "sess_current",
          port: port({
            ref: "zcode-artifact://sess_current/upload",
            fileName: "notes.txt",
            mime: "text/plain",
            bytes: PAYLOAD.byteLength,
          }),
          artifactStore: store,
          signal: controller.signal,
        }),
      ),
      /cancelled/,
    );
    assert.equal(store.written, undefined);
  });

  it("只在注入话题资源端口时注册，且不随动态工作流灰度下架", () => {
    const names = (includeTopicResource?: boolean) => {
      const entries: { metadata: { name: string } }[] = [];
      registerBuiltInTools({ register: (entry) => entries.push(entry as never) }, {
        includeTopicResource,
        includeDynamicWorkflow: false,
      });
      return entries.map((entry) => entry.metadata.name);
    };
    assert.equal(names(true).includes(READ_TOPIC_RESOURCE_TOOL_NAME), true);
    assert.equal(names(false).includes(READ_TOPIC_RESOURCE_TOOL_NAME), false);
    assert.equal(names(undefined).includes(READ_TOPIC_RESOURCE_TOOL_NAME), false);
  });
});
