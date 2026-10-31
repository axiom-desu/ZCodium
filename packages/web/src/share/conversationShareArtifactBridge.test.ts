import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES } from "@zcode/shared";

import { createConversationShareArtifactReader } from "./conversationShareArtifactBridge.js";

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function loopbackServer(
  handler: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const captured: CapturedRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
    };
    requests.push(captured);
    handler(captured, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        // 超大分块/声明长度用例会被客户端主动取消，关闭所有连接避免清理时挂住。
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

describe("conversation share artifact bridge", () => {
  it("reads artifacts with an anonymous GET and no referrer", async () => {
    const { baseUrl, requests } = await loopbackServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("hello");
    });
    const init: RequestInit[] = [];
    const reader = createConversationShareArtifactReader({
      fetchImpl: (input, options) => {
        init.push(options ?? {});
        const headers = new Headers(options?.headers);
        // 模拟浏览器默认的同源 cookie：只有显式 omit 才不带。
        if (options?.credentials !== "omit") headers.set("cookie", "share-session=cookie-secret");
        return fetch(input, { ...options, headers });
      },
    });
    const result = await reader.read(`${baseUrl}/files/a.txt`);
    expect(new TextDecoder().decode(result.bytes)).toBe("hello");
    expect(result.mediaType).toBe("text/plain");
    expect(init[0]).toMatchObject({
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(requests[0]?.headers.cookie).toBeUndefined();

    // 控制探针证明同一套 host 能看到默认 cookie 语义。
    const probe = await fetch(`${baseUrl}/probe`, {
      headers: { cookie: "share-session=cookie-secret" },
    });
    await probe.text();
    expect(requests.find((entry) => entry.url === "/probe")?.headers.cookie).toContain(
      "share-session=cookie-secret",
    );
  });

  it("cancels a chunked artifact body without Content-Length once it exceeds the artifact budget", async () => {
    const { baseUrl } = await loopbackServer((_request, response) => {
      response.on("error", () => undefined);
      response.writeHead(200, { "Content-Type": "text/markdown" });
      const chunk = Buffer.alloc(4 * 1024 * 1024, "x");
      for (let index = 0; index < 5; index += 1) {
        if (response.destroyed) break;
        response.write(chunk);
      }
      if (!response.destroyed) response.end();
    });
    const reader = createConversationShareArtifactReader();
    await expect(reader.read(`${baseUrl}/files/large.md`)).rejects.toMatchObject({
      kind: "limit_exceeded",
    });
  });

  it("rejects an over-limit declared Content-Length before reading the body", async () => {
    const { baseUrl } = await loopbackServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/markdown",
        "Content-Length": String(CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES + 1),
      });
      response.write("x");
    });
    const reader = createConversationShareArtifactReader();
    await expect(reader.read(`${baseUrl}/files/declared.md`)).rejects.toMatchObject({
      kind: "limit_exceeded",
    });
  });

  it("never fetches unsupported protocols", async () => {
    let calls = 0;
    const reader = createConversationShareArtifactReader({
      fetchImpl: async () => {
        calls += 1;
        return new Response("");
      },
    });
    for (const unsafe of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "zcode-artifact://share/a1",
      "blob:https://share.example/abc",
      "data:text/plain,hello",
    ]) {
      await expect(reader.read(unsafe)).rejects.toMatchObject({ kind: "unsupported_url" });
    }
    expect(calls).toBe(0);
  });

  it("maps unavailable responses to a typed error", async () => {
    const { baseUrl } = await loopbackServer((_request, response) => {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("missing");
    });
    const reader = createConversationShareArtifactReader();
    await expect(reader.read(`${baseUrl}/files/missing`)).rejects.toMatchObject({
      kind: "unavailable",
      status: 404,
    });
  });
});
