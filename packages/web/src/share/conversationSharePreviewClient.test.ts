import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationSharePreviewClient,
  ConversationSharePreviewClientError,
  isConversationSharePath,
  isSafeConversationShareCode,
  parseConversationShareRoute,
  resolveConversationShareRouteLocale,
} from "./conversationSharePreviewClient.js";
import { CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES } from "@zcode/shared";

const SHA = "a".repeat(64);

const ROWS = [
  {
    rowId: 1,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
  },
  {
    rowId: 2,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1,
    createdAtSeq: 2,
    kind: "userInput",
    origin: "realUser",
    text: "hello",
    clientId: "client-1",
  },
  {
    rowId: 3,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1,
    createdAtSeq: 3,
    kind: "assistantText",
    state: "complete",
    text: "world",
  },
  { kind: "futureRow", rowId: 4 },
];

function previewPayload() {
  return {
    schema_version: 1,
    share: {
      title: "Shared plan",
      access_mode: "public_readonly",
      created_at: 1,
      expires_at: 2,
    },
    rows: ROWS,
    content_blocks: [
      {
        id: "share-content-1",
        type: "workflow",
        version: 2,
        product_turn_id: "share-product-turn-1",
        fallback_row_id: 3,
        captured_at: 1,
        resource_ids: [],
        payload: { name: "Weekly", completion: true, artifacts: [] },
      },
      { type: "future-content-block", version: 7 },
    ],
    artifacts: [],
    integrity: { projection_sha256: SHA, artifact_set_sha256: SHA },
  };
}

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function loopbackShareServer(
  handler: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const captured: CapturedRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      };
      requests.push(captured);
      handler(captured, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        // 拒绝“声明了超大 Content-Length 但服务端不急于结束”的连接，避免测试清理时挂住。
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { baseUrl: `http://127.0.0.1:${address.port}/api/v1`, requests };
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

describe("conversation share route", () => {
  it("only treats canonical share paths as share pages", () => {
    expect(isConversationSharePath("/share/abc")).toBe(true);
    expect(isConversationSharePath("/cn/share/abc")).toBe(true);
    expect(isConversationSharePath("/share")).toBe(true);
    expect(isConversationSharePath("/cn/share")).toBe(true);
    expect(isConversationSharePath("/workspace/share/abc")).toBe(false);
    // 百分号编码只还原 code，不还原路径语义：解出含分隔符的 code 一律拒绝。
    expect(parseConversationShareRoute("/cn/share/a%2Fb")).toBeNull();
    expect(parseConversationShareRoute("/share/..%2Fetc")).toBeNull();
    expect(parseConversationShareRoute("/share/abc_DEF.123~-")).toBe("abc_DEF.123~-");
    expect(parseConversationShareRoute("/other/abc")).toBeNull();
    expect(isSafeConversationShareCode("abc_DEF.123~-")).toBe(true);
    expect(isSafeConversationShareCode("abc/def")).toBe(false);
  });

  it("rejects dot segments and their encoded variants without rewriting other dots", () => {
    // `encodeURIComponent("..")` 仍是 ".."，URL 解析器会把 /shares/../preview 折叠成
    // /preview，所以整段点号必须在发请求前就拒绝。
    for (const code of [".", ".."]) {
      expect(isSafeConversationShareCode(code)).toBe(false);
      expect(parseConversationShareRoute(`/share/${code}`)).toBeNull();
      expect(parseConversationShareRoute(`/cn/share/${code}`)).toBeNull();
    }
    // 解码变体：.%2e / %2e. / %2e%2e / %2E 大小写都是同一个非法整段。
    for (const raw of [".%2e", "%2e.", "%2e%2e", "%2E%2E", "%2e", ".%2E"]) {
      expect(parseConversationShareRoute(`/share/${raw}`)).toBeNull();
      expect(parseConversationShareRoute(`/cn/share/${raw}`)).toBeNull();
    }
    // 其它位置的点号是合法 code，必须原样保留（不 trim、不归一化、不改写）。
    for (const code of ["a..b", ".abc", "abc.", "a~b.c-d", "a.%2e"]) {
      const decoded = code.replace("%2e", ".");
      expect(isSafeConversationShareCode(decoded)).toBe(true);
      expect(parseConversationShareRoute(`/share/${code}`)).toBe(decoded);
    }
  });

  it("derives the page locale from the path prefix", () => {
    expect(resolveConversationShareRouteLocale("/cn/share/abc")).toBe("zh-CN");
    expect(resolveConversationShareRouteLocale("/share/abc")).toBe("en-US");
  });
});

describe("conversation share preview client", () => {
  it("issues a real GET to the injected loopback endpoint and decodes rows", async () => {
    const { baseUrl, requests } = await loopbackShareServer((_request, response) => {
      jsonResponse(response, 200, { code: 0, msg: "ok", data: previewPayload() });
    });
    const events: Array<[string, Record<string, unknown>]> = [];
    const client = new ConversationSharePreviewClient({
      baseUrl,
      diagnostics: {
        info: (event, details) => events.push([event, details]),
        warn: (event, details) => events.push([event, details]),
      },
    });
    const preview = await client.getPreview("abc_DEF-123");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe("/api/v1/shares/abc_DEF-123/preview");
    expect(request.body).toBe("");
    // 预览是匿名读取：不得携带任何鉴权头。
    expect(request.headers.authorization).toBeUndefined();
    expect(preview.rows).toHaveLength(3);
    expect(preview.unsupportedRowCount).toBe(1);
    expect(preview.share.title).toBe("Shared plan");
    expect(preview.content_blocks).toHaveLength(2);
    // 诊断日志不得包含 share code。
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("abc_DEF-123");
    expect(serialized).toContain("<redacted>");
  });

  it("reads as anonymous: no credentials and no referrer", async () => {
    const { baseUrl } = await loopbackShareServer((_request, response) => {
      jsonResponse(response, 200, { code: 0, msg: "ok", data: previewPayload() });
    });
    const init: RequestInit[] = [];
    const client = new ConversationSharePreviewClient({
      baseUrl,
      fetchImpl: (input, options) => {
        if (options) init.push(options);
        return fetch(input, options);
      },
    });
    await client.getPreview("anonymous");
    expect(init[0]?.method).toBe("GET");
    // 同源部署下浏览器默认会带上访客 cookie；匿名读取必须显式退出凭据。
    expect(init[0]?.credentials).toBe("omit");
    expect(init[0]?.referrerPolicy).toBe("no-referrer");
  });

  it("cancels a chunked preview body without Content-Length once it exceeds the contract bound", async () => {
    const { baseUrl, requests } = await loopbackShareServer((_request, response) => {
      response.on("error", () => undefined);
      // 分块响应故意不声明 Content-Length：只能靠累计字节数截止。
      response.writeHead(200, { "Content-Type": "application/json" });
      const chunk = "x".repeat(1024 * 1024);
      for (let index = 0; index < 6; index += 1) response.write(chunk);
      response.end();
    });
    const client = new ConversationSharePreviewClient({ baseUrl });
    await expect(client.getPreview("chunked")).rejects.toMatchObject({
      kind: "limit_exceeded",
      status: 200,
    });
    expect(requests[0]?.headers["content-length"]).toBeUndefined();
  });

  it("rejects an over-limit declared Content-Length before reading the body", async () => {
    const { baseUrl } = await loopbackShareServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(CONVERSATION_SHARE_PREVIEW_MAX_BODY_BYTES + 1),
      });
      response.write("{");
    });
    const client = new ConversationSharePreviewClient({ baseUrl });
    await expect(client.getPreview("declared")).rejects.toMatchObject({
      kind: "limit_exceeded",
      status: 200,
    });
  });

  it("classifies business errors without collapsing them into invalid_contract", async () => {
    const { baseUrl } = await loopbackShareServer((_request, response) => {
      jsonResponse(response, 404, {
        code: 3211,
        msg: "share not found",
        logid: "log-1",
        data: { rule: "not_found" },
      });
    });
    const client = new ConversationSharePreviewClient({ baseUrl, fetchImpl: fetch });
    await expect(client.getPreview("missing")).rejects.toMatchObject({
      name: "ConversationSharePreviewClientError",
      kind: "not_found",
      status: 404,
      code: 3211,
      requestId: "log-1",
    });
  });

  it("asks the visitor to upgrade when the payload version is newer", async () => {
    const { baseUrl } = await loopbackShareServer((_request, response) => {
      jsonResponse(response, 200, {
        code: 0,
        msg: "ok",
        data: { ...previewPayload(), schema_version: 9 },
      });
    });
    const client = new ConversationSharePreviewClient({ baseUrl });
    await expect(client.getPreview("newer")).rejects.toMatchObject({
      kind: "unsupported_schema_version",
    });
  });

  it("rejects artifact URLs outside http(s) instead of trusting the response", async () => {
    const { baseUrl } = await loopbackShareServer((_request, response) => {
      jsonResponse(response, 200, {
        code: 0,
        msg: "ok",
        data: {
          ...previewPayload(),
          artifacts: [
            {
              artifact_id: "share-artifact-1",
              logical_artifact_key: "k",
              producer_product_turn_id: "p",
              artifact_version: 1,
              state: "current",
              ref: "zcode-artifact://share/a1",
              artifact_type: "html",
              display_name: "index.html",
              extension: "html",
              mime_type: "text/html",
              size_bytes: 3,
              sha256: SHA,
              url: "javascript:alert(1)",
              url_expires_at: 1,
            },
          ],
        },
      });
    });
    const client = new ConversationSharePreviewClient({ baseUrl });
    await expect(client.getPreview("unsafe")).rejects.toMatchObject({ kind: "invalid_contract" });
  });

  it("never sends the share code to the network path when it is unsafe", async () => {
    const { baseUrl, requests } = await loopbackShareServer((_request, response) => {
      jsonResponse(response, 200, { code: 0, msg: "ok", data: previewPayload() });
    });
    const client = new ConversationSharePreviewClient({ baseUrl });
    await expect(client.getPreview("../etc/passwd")).rejects.toBeInstanceOf(
      ConversationSharePreviewClientError,
    );
    // `.`/`..` 不是“另一次请求”，而是不发请求：否则 `/shares/../preview` 会被 URL
    // 解析器归一化成 `/preview`，实际请求了 code 以外的 endpoint。
    for (const code of [".", ".."]) {
      await expect(client.getPreview(code)).rejects.toMatchObject({ kind: "invalid_contract" });
    }
    expect(requests).toHaveLength(0);
  });

  it("forwards a legal code containing dots verbatim without normalizing the endpoint", async () => {
    const { baseUrl, requests } = await loopbackShareServer((_request, response) => {
      jsonResponse(response, 200, { code: 0, msg: "ok", data: previewPayload() });
    });
    const client = new ConversationSharePreviewClient({ baseUrl });
    await client.getPreview("a..b.c~d");
    expect(requests.map((entry) => entry.url)).toEqual(["/api/v1/shares/a..b.c~d/preview"]);
  });

  it("maps transport failures to network and redacts the code from diagnostics", async () => {
    const warned: Array<[string, Record<string, unknown>]> = [];
    const client = new ConversationSharePreviewClient({
      baseUrl: "http://127.0.0.1:1/api/v1",
      fetchImpl: async (input) => {
        throw new Error(`connect ECONNREFUSED ${String(input)}`);
      },
      diagnostics: {
        info: () => {},
        warn: (event, details) => warned.push([event, details]),
      },
    });
    await expect(client.getPreview("secret-code")).rejects.toMatchObject({ kind: "network" });
    expect(JSON.stringify(warned)).not.toContain("secret-code");
  });
});
