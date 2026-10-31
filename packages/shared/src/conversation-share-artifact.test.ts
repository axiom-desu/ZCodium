import { describe, expect, it, vi } from "vitest";

import {
  BoundedResponseBodyError,
  decodeBoundedResponseBodyText,
  readBoundedResponseBody,
} from "./bounded-response-body.js";
import { CONVERSATION_ARCHIVE_LIMITS } from "./conversation-archive.js";
import {
  CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES,
  ConversationShareArtifactReadError,
  classifyConversationShareArtifactUrl,
  decodeConversationShareDataUrl,
} from "./conversation-share-artifact.js";

describe("conversation share artifact contract", () => {
  it("derives the body budget from the archive artifact allowance instead of a smaller guess", () => {
    // 服务端能力声明的 max_artifact_bytes 与归档合同的 artifactBytes 是同一个事实；
    // 读取端不能用一个更小的“防大响应”值把合法 artifact 读坏。
    expect(CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES).toBe(
      CONVERSATION_ARCHIVE_LIMITS.artifactBytes,
    );
    expect(CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES).toBeGreaterThanOrEqual(
      CONVERSATION_ARCHIVE_LIMITS.artifactBytes,
    );
  });

  it("whitelists only http(s) for the network and data for local decoding", () => {
    expect(classifyConversationShareArtifactUrl("https://share.example/a.png")).toEqual({
      kind: "network",
      url: "https://share.example/a.png",
    });
    expect(classifyConversationShareArtifactUrl("http://127.0.0.1:1234/files/a")).toEqual({
      kind: "network",
      url: "http://127.0.0.1:1234/files/a",
    });
    expect(classifyConversationShareArtifactUrl("data:text/plain,hello")).toEqual({
      kind: "data",
      url: "data:text/plain,hello",
    });

    // 反例必须逐项被拒绝：这些协议都不能交给 fetch，也不能被当作公开 artifact。
    for (const unsafe of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "zcode-artifact://share/a1",
      "blob:https://share.example/abc",
      "ftp://share.example/a.png",
      "/relative/path",
      "",
    ]) {
      expect(classifyConversationShareArtifactUrl(unsafe)).toBeNull();
    }
  });

  it("decodes existing data URLs locally and enforces the same artifact budget", () => {
    expect(decodeConversationShareDataUrl("data:text/plain,hello")).toEqual({
      bytes: new TextEncoder().encode("hello"),
      mediaType: "text/plain",
    });
    expect(decodeConversationShareDataUrl("data:image/png;base64,aGVsbG8=")).toEqual({
      bytes: new TextEncoder().encode("hello"),
      mediaType: "image/png",
    });
    expect(() => decodeConversationShareDataUrl("data:text/plain,hello", 4)).toThrowError(
      expect.objectContaining({ kind: "limit_exceeded" }),
    );
    expect(() => decodeConversationShareDataUrl("data:text/plain,%E0%A4%A")).toThrowError(
      ConversationShareArtifactReadError,
    );
    expect(() => decodeConversationShareDataUrl("not-a-data-url")).toThrowError(
      expect.objectContaining({ kind: "unsupported_url" }),
    );
  });

  it("rejects an over-budget data URL before decoding it, using the real contract budget", () => {
    // 合同的预算就是调用方给的 maxBytes；这里用小预算证明判定用的是参数而不是另一个硬编码值。
    const atobSpy = vi.spyOn(globalThis, "atob");
    const decodeUriSpy = vi.spyOn(globalThis, "decodeURIComponent");
    try {
      // base64："QUJDRA==" 解码 4 字节，预算 3 必须先拒绝（不得先 atob 分配）。
      expect(() =>
        decodeConversationShareDataUrl("data:image/png;base64,QUJDRA==", 3),
      ).toThrowError(expect.objectContaining({ kind: "limit_exceeded" }));
      // percent-encoding：15 个编码字符的解码下界是 5 字节，预算 4 必须先拒绝。
      expect(() =>
        decodeConversationShareDataUrl(`data:text/plain,${"%41".repeat(5)}`, 4),
      ).toThrowError(expect.objectContaining({ kind: "limit_exceeded" }));
      expect(atobSpy).not.toHaveBeenCalled();
      expect(decodeUriSpy).not.toHaveBeenCalled();

      // 边界不能误伤：恰好等于预算的输入必须仍然解码成功。
      expect(decodeConversationShareDataUrl("data:image/png;base64,QUJDRA==", 4).bytes).toEqual(
        new TextEncoder().encode("ABCD"),
      );
      expect(decodeConversationShareDataUrl(`data:text/plain,${"%41".repeat(4)}`, 4).bytes).toEqual(
        new TextEncoder().encode("AAAA"),
      );
      // padding 不能被算成解码字节："QQ==" 只解出 1 字节。
      expect(decodeConversationShareDataUrl("data:text/plain;base64,QQ==", 1).bytes).toEqual(
        new TextEncoder().encode("A"),
      );
    } finally {
      atobSpy.mockRestore();
      decodeUriSpy.mockRestore();
    }
  });
});

describe("bounded response body reader", () => {
  it("reads a body under the budget and decodes it as UTF-8", async () => {
    const bytes = await readBoundedResponseBody(new Response("hello 世界"), 64);
    expect(decodeBoundedResponseBodyText(bytes)).toBe("hello 世界");
  });

  it("rejects a declared Content-Length over the budget before reading and cancels the body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel,
    });
    const response = new Response(body, { headers: { "Content-Length": "9" } });
    await expect(readBoundedResponseBody(response, 8)).rejects.toMatchObject({
      kind: "limit_exceeded",
      declaredBytes: 9,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a chunked body without Content-Length as soon as the running total exceeds the budget", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 10) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel,
    });
    const response = new Response(body);
    await expect(readBoundedResponseBody(response, 4)).rejects.toMatchObject({
      kind: "limit_exceeded",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    // 第一块 3 字节未超，第二块到 6 字节立刻截止；不应把后续 8 块也读完。
    expect(pulls).toBe(2);
  });

  it("rejects an invalid declared content length and cancels the body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: { "Content-Length": "nope" } });
    await expect(readBoundedResponseBody(response, 8)).rejects.toBeInstanceOf(
      BoundedResponseBodyError,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
