// ============================================================
// 话题资源纵向：bot 入站接纳 → Host 授权/下载 → 反向回传
// ============================================================
// 真实链路：真实 feishu provider + loopback HTTP（仅本机 127.0.0.1）+ 真实接纳归档 +
// 真实 Host bridge。跑在 runner 已隔离的 HOME/XDG 下，不读用户配置、不连真远端。

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { BotConfig, BotInboundMessage } from "@zcode/shared";
import { BotsTopicArchive, topicResourceAuthorizationId } from "../src/bots/topicArchive.js";
import { authorizeTopicResource, readAuthorizedTopicResource } from "../src/bots/topicResource.js";
import { createFeishuBotProvider } from "../src/bots/providers/feishuProvider.js";
import { createTopicResourceBridge } from "../src/zcode-agent/topicResourceBridge.js";

const FILE_BYTES = Buffer.from("topic-resource-from-feishu");
const WORKSPACE = "/tmp/zcode-topic-resource-workspace";
const CHUNK_BYTES = 256 * 1024;

const bot = {
  id: "bot-feishu",
  name: "Feishu",
  provider: "feishu",
  enabled: true,
  credentialRef: "cred-feishu",
  feishuAppId: "cli_0123456789abcdef",
  providerUserId: "ou_bot",
  allowedWorkspaces: [],
  allowedCommands: {},
  currentOptions: {},
  replyMode: "summary",
} as unknown as BotConfig;

function inboundMessage(providerMessageId = "om_1"): BotInboundMessage {
  return {
    botId: bot.id,
    text: "please archive",
    actor: {
      botId: bot.id,
      provider: "feishu",
      providerUserId: "ou_user",
      chatType: "group",
      chatId: "oc_1",
      providerMessageId,
    },
    attachments: [
      {
        id: "att-1",
        kind: "file",
        filename: "report.txt",
        mimeType: "text/plain",
        sizeBytes: FILE_BYTES.byteLength,
        providerFileId: "file_key_ok",
      },
    ],
  };
}

interface Harness {
  server: Server;
  base: string;
  archive: BotsTopicArchive;
  provider: ReturnType<typeof createFeishuBotProvider>;
  restore(): Promise<void>;
}

let harness: Harness;

async function startHarness(): Promise<Harness> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      return;
    }
    if (url.pathname.endsWith("/resources/file_key_ok")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(FILE_BYTES);
      return;
    }
    if (url.pathname.endsWith("/resources/file_key_redirect_ok")) {
      response.writeHead(302, { location: "https://open.feishu.cn/open-apis/cdn/ok" });
      response.end();
      return;
    }
    if (url.pathname === "/open-apis/cdn/ok") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(FILE_BYTES);
      return;
    }
    if (url.pathname.endsWith("/resources/file_key_redirect_evil")) {
      response.writeHead(302, { location: "https://evil.example/steal" });
      response.end();
      return;
    }
    if (url.pathname.endsWith("/resources/file_key_big")) {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1),
      });
      response.end(FILE_BYTES);
      return;
    }
    if (url.pathname.endsWith("/resources/file_key_slow")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      // 不结束响应：等待调用方取消。
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 404, msg: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback listen failed");
  const base = `127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  // 只把飞书官方域重写到本机 loopback，provider 仍然只认识官方 URL 与其重定向校验。
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.host === "open.feishu.cn" || url.host === "open.larksuite.com") {
      url.protocol = "http:";
      url.host = base;
    }
    return realFetch(url, init);
  }) as typeof fetch;
  const dataDir = await mkdtemp(join(tmpdir(), "zcode-topic-resource-"));
  return {
    server,
    base,
    archive: new BotsTopicArchive({ filePath: join(dataDir, "bots-topic-archive.json") }),
    provider: createFeishuBotProvider({
      loadCredential: async () => "app-secret",
      onDeliveryResult: () => undefined,
    }),
    restore: async () => {
      globalThis.fetch = realFetch;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.restore();
});

interface UploadResult {
  ref: string;
  bytes: number;
  chunks: number;
}

function bridge(
  archive: BotsTopicArchive,
  options: { config?: BotConfig; uploadDelayMs?: number } = {},
) {
  const uploads: UploadResult[] = [];
  const bridge = createTopicResourceBridge({
    validate: async (request, signal) => {
      await authorizeTopicResource(
        { ...request, workspacePath: WORKSPACE, signal },
        {
          archive,
          readConfig: async () => ({ version: 3, bots: [options.config ?? bot] }) as never,
        },
      );
    },
    read: async (request, signal) => {
      const result = await readAuthorizedTopicResource(
        { ...request, workspacePath: WORKSPACE, signal },
        {
          archive,
          readConfig: async () => ({ version: 3, bots: [options.config ?? bot] }) as never,
          download: async (config, attachment, target, downloadSignal) => {
            const provider = createFeishuBotProvider({
              loadCredential: async () => "app-secret",
              onDeliveryResult: () => undefined,
            });
            const downloaded = await provider.downloadTopicResource!(
              config,
              attachment,
              target,
              downloadSignal,
            );
            if (!downloaded) throw new Error("download unavailable");
            return downloaded;
          },
        },
      );
      return {
        fileName: result.attachment.filename,
        mime: result.attachment.mimeType,
        bytes: result.data,
      };
    },
    upload: async (_request, payload, signal) => {
      if (options.uploadDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.uploadDelayMs));
      signal.throwIfAborted();
      // 模拟 v4 attachment begin/chunk/commit 的寄存结果：块数与校验和都来自真实字节。
      let offset = 0;
      let chunks = 0;
      while (offset < payload.bytes.byteLength) {
        signal.throwIfAborted();
        offset = Math.min(payload.bytes.byteLength, offset + CHUNK_BYTES);
        chunks += 1;
      }
      const ref = `zcode-artifact://sess-topic/upload-${randomUUID()}`;
      uploads.push({ ref, bytes: payload.bytes.byteLength, chunks });
      return { ref, bytes: payload.bytes.byteLength };
    },
  });
  return { bridge, uploads };
}

async function admit(
  archive: BotsTopicArchive,
  options: {
    taskId?: string;
    inputId?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    message?: BotInboundMessage;
  } = {},
) {
  return archive.admit({
    workspacePath: options.workspacePath ?? WORKSPACE,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    taskId: options.taskId ?? "task-1",
    inputId: options.inputId ?? "input-1",
    bot,
    message: options.message ?? inboundMessage(),
  });
}

describe("话题资源纵向（loopback ingress → admission → tool 前向端口）", () => {
  it("已接纳资源经原 bot 渠道下载并回传 CLI ref", async () => {
    const { bridge: hostBridge, uploads } = bridge(harness.archive);
    await admit(harness.archive);
    const result = await hostBridge.read({
      requestId: "req-1",
      taskId: "task-1",
      inputId: "input-1",
      messageId: "om_1",
      resourceIndex: 0,
    });
    assert.match(result.ref, /^zcode-artifact:\/\//);
    assert.equal(result.fileName, "report.txt");
    assert.equal(result.mime, "text/plain");
    assert.equal(result.bytes, FILE_BYTES.byteLength);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.chunks, 1);
  });

  it("资源索引附件只暴露选择器，不泄漏 provider 资源键或 URL", async () => {
    const archive = new BotsTopicArchive({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-topic-index-")), "archive.json"),
    });
    await admit(archive);
    const attachment = await archive.indexAttachment({
      taskId: "task-1",
      workspacePath: WORKSPACE,
    });
    assert.ok(attachment);
    assert.equal(attachment!.filename, "topicResources.txt");
    const text = (attachment as { textContent?: string }).textContent ?? "";
    assert.match(text, /A1 inputId=input-1 messageId=om_1 index=0/);
    assert.equal(text.includes("file_key_ok"), false);
    assert.equal(text.includes("http"), false);
  });

  it("未接纳输入、跨任务与越界序号都拒绝，且不产生 ref", async () => {
    const archive = new BotsTopicArchive({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-topic-negative-")), "archive.json"),
    });
    const { bridge: hostBridge, uploads } = bridge(archive);
    await admit(archive);
    const attempts: Array<Record<string, unknown>> = [
      { taskId: "task-other", inputId: "input-1", messageId: "om_1", resourceIndex: 0 },
      { taskId: "task-1", inputId: "input-other", messageId: "om_1", resourceIndex: 0 },
      { taskId: "task-1", inputId: "input-1", messageId: "om_missing", resourceIndex: 0 },
      { taskId: "task-1", inputId: "input-1", messageId: "om_1", resourceIndex: 3 },
      // 模型伪造字段：strict schema 直接拒绝，契约里根本没有 URL/路径入口。
      {
        taskId: "task-1",
        inputId: "input-1",
        messageId: "om_1",
        resourceIndex: 0,
        url: "https://evil.example/x",
      },
    ];
    for (const attempt of attempts) {
      await assert.rejects(hostBridge.read({ requestId: `req-${randomUUID()}`, ...attempt }));
    }
    assert.deepEqual(uploads, []);
  });

  it("bot 停用或凭据换代后拒绝，即使归档仍存在", async () => {
    const archive = new BotsTopicArchive({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-topic-rotate-")), "archive.json"),
    });
    await admit(archive);
    await assert.doesNotReject(
      authorizeTopicResource(
        {
          taskId: "task-1",
          inputId: "input-1",
          messageId: "om_1",
          resourceIndex: 0,
          workspacePath: WORKSPACE,
        },
        { archive, readConfig: async () => ({ version: 3, bots: [bot] }) as never },
      ),
    );
    const rotated = { ...bot, credentialRef: "cred-feishu-rotated" } as BotConfig;
    await assert.rejects(
      bridge(archive, { config: rotated }).bridge.read({
        requestId: "req-rotated",
        taskId: "task-1",
        inputId: "input-1",
        messageId: "om_1",
        resourceIndex: 0,
      }),
      /authorization unavailable/,
    );
    await assert.rejects(
      authorizeTopicResource(
        {
          taskId: "task-1",
          inputId: "input-1",
          messageId: "om_1",
          resourceIndex: 0,
          workspacePath: WORKSPACE,
        },
        { archive, readConfig: async () => ({ version: 3, bots: [rotated] }) as never },
      ),
      /authorization unavailable/,
    );
    const disabled = { ...bot, enabled: false } as BotConfig;
    await assert.rejects(
      authorizeTopicResource(
        {
          taskId: "task-1",
          inputId: "input-1",
          messageId: "om_1",
          resourceIndex: 0,
          workspacePath: WORKSPACE,
        },
        { archive, readConfig: async () => ({ version: 3, bots: [disabled] }) as never },
      ),
      /authorization unavailable/,
    );
  });

  it("下载期间新接纳输入换代时拒绝交付旧快照字节", async () => {
    const archive = new BotsTopicArchive({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-topic-swap-")), "archive.json"),
    });
    await admit(archive);
    await assert.rejects(
      readAuthorizedTopicResource(
        {
          taskId: "task-1",
          messageId: "om_1",
          resourceIndex: 0,
          workspacePath: WORKSPACE,
        },
        {
          archive,
          readConfig: async () => ({ version: 3, bots: [bot] }) as never,
          download: async (_config, attachment) => {
            // 模拟下载期间同一任务又接纳了新的输入：当前任务归属已换代，
            // 旧快照的字节不得继续交付。
            await admit(archive, { inputId: "input-2" });
            return { attachment, data: new Uint8Array(FILE_BYTES) };
          },
        },
      ),
      /authorization changed/,
    );
  });

  it("bot app/身份换代后旧快照授权失效（credentialRef 不变）", async () => {
    const archive = new BotsTopicArchive({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-topic-appid-")), "archive.json"),
    });
    await admit(archive);
    for (const rotated of [
      { ...bot, feishuAppId: "cli_rotated_identity" },
      { ...bot, providerUserId: "ou_rotated_bot" },
    ]) {
      await assert.rejects(
        authorizeTopicResource(
          {
            taskId: "task-1",
            inputId: "input-1",
            messageId: "om_1",
            resourceIndex: 0,
            workspacePath: WORKSPACE,
          },
          {
            archive,
            readConfig: async () => ({ version: 3, bots: [rotated] }) as never,
          },
        ),
        /authorization unavailable/,
      );
    }
  });

  it("取消中止下载且不发布引用", async () => {
    const { bridge: hostBridge, uploads } = bridge(harness.archive);
    await admit(harness.archive, {
      inputId: "input-slow",
      message: {
        ...inboundMessage("om_slow"),
        attachments: [
          {
            id: "att-slow",
            kind: "file",
            filename: "slow.txt",
            mimeType: "text/plain",
            providerFileId: "file_key_slow",
          },
        ],
      },
    });
    const pending = hostBridge.read({
      requestId: "req-slow",
      taskId: "task-1",
      inputId: "input-slow",
      messageId: "om_slow",
      resourceIndex: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hostBridge.cancel({ requestId: "req-slow", taskId: "task-1" }), true);
    await assert.rejects(pending, /cancel|abort/i);
    assert.deepEqual(uploads, []);
    // 同一 requestId 取消后可以重新发起，旧取消不能污染新请求。
    assert.equal(hostBridge.cancel({ requestId: "req-slow", taskId: "task-1" }), false);
  });

  it("并发同一 requestId 只允许一个，超限重定向与非飞书域都被拒绝", async () => {
    const { bridge: hostBridge } = bridge(harness.archive);
    const first = hostBridge.read({
      requestId: "req-dup",
      taskId: "task-1",
      inputId: "input-1",
      messageId: "om_1",
      resourceIndex: 0,
    });
    await assert.rejects(
      hostBridge.read({
        requestId: "req-dup",
        taskId: "task-1",
        inputId: "input-1",
        messageId: "om_1",
        resourceIndex: 0,
      }),
      /already active/,
    );
    await first;

    const evil = new BotsTopicArchive({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-topic-evil-")), "archive.json"),
    });
    await admit(evil, {
      inputId: "input-evil",
      message: {
        ...inboundMessage("om_evil"),
        attachments: [
          {
            id: "att-evil",
            kind: "file",
            filename: "evil.txt",
            mimeType: "text/plain",
            providerFileId: "file_key_redirect_evil",
          },
        ],
      },
    });
    const evilBridge = bridge(evil);
    await assert.rejects(
      evilBridge.bridge.read({
        requestId: "req-evil",
        taskId: "task-1",
        inputId: "input-evil",
        messageId: "om_evil",
        resourceIndex: 0,
      }),
      /redirect host is not allowed/,
    );

    const allowedRedirect = new BotsTopicArchive({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-topic-redirect-")), "archive.json"),
    });
    await admit(allowedRedirect, {
      inputId: "input-redirect",
      message: {
        ...inboundMessage("om_redirect"),
        attachments: [
          {
            id: "att-redirect",
            kind: "file",
            filename: "ok.txt",
            mimeType: "text/plain",
            providerFileId: "file_key_redirect_ok",
          },
        ],
      },
    });
    const redirected = bridge(allowedRedirect);
    const result = await redirected.bridge.read({
      requestId: "req-redirect",
      taskId: "task-1",
      inputId: "input-redirect",
      messageId: "om_redirect",
      resourceIndex: 0,
    });
    assert.equal(result.bytes, FILE_BYTES.byteLength);
    assert.equal(
      createHash("sha256").update(Buffer.from("topic-resource-from-feishu")).digest("hex"),
      createHash("sha256").update(FILE_BYTES).digest("hex"),
    );
  });

  it("声明大小超限时下载前拒绝，不产生字节", async () => {
    const archive = new BotsTopicArchive({
      filePath: join(await mkdtemp(join(tmpdir(), "zcode-topic-big-")), "archive.json"),
    });
    await admit(archive, {
      inputId: "input-big",
      message: {
        ...inboundMessage("om_big"),
        attachments: [
          {
            id: "att-big",
            kind: "file",
            filename: "big.bin",
            mimeType: "application/octet-stream",
            providerFileId: "file_key_big",
          },
        ],
      },
    });
    const big = bridge(archive);
    await assert.rejects(
      big.bridge.read({
        requestId: "req-big",
        taskId: "task-1",
        inputId: "input-big",
        messageId: "om_big",
        resourceIndex: 0,
      }),
      /size limit/,
    );
    assert.deepEqual(big.uploads, []);
  });

  it("接纳归档只由 accept 写入：不支持 provider 不落盘", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "zcode-topic-provider-"));
    const archive = new BotsTopicArchive({ filePath: join(dataDir, "archive.json") });
    await assert.rejects(
      archive.admit({
        workspacePath: WORKSPACE,
        taskId: "task-1",
        inputId: "input-1",
        bot: { ...bot, provider: "telegram" } as BotConfig,
        message: inboundMessage(),
      }),
      /not supported/,
    );
    await assert.rejects(
      archive.lookup({
        taskId: "task-1",
        workspacePath: WORKSPACE,
        messageId: "om_1",
        resourceIndex: 0,
      }),
      /task scope is unavailable/,
    );
  });

  it("授权指纹与 workspace 身份绑定：同路径不同 identity 互不可读", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "zcode-topic-identity-"));
    const archive = new BotsTopicArchive({ filePath: join(dataDir, "archive.json") });
    const snapshot = await admit(archive, { workspaceIdentity: "remote://host-a/tmp/ws" });
    assert.equal(snapshot.authorizationId, topicResourceAuthorizationId(bot, "oc_1"));
    await assert.rejects(
      archive.lookup({
        taskId: "task-1",
        workspacePath: WORKSPACE,
        workspaceIdentity: "remote://host-b/tmp/ws",
        messageId: "om_1",
        resourceIndex: 0,
      }),
      /task scope is unavailable/,
    );
    const found = await archive.lookup({
      taskId: "task-1",
      workspacePath: WORKSPACE,
      workspaceIdentity: "remote://host-a/tmp/ws",
      messageId: "om_1",
      resourceIndex: 0,
    });
    assert.equal(found.snapshot.generation, 1);
  });
});
