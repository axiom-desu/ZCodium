import { describe, expect, it, vi } from "vitest";

import { ConversationShareArtifactReadError } from "@zcode/shared";

import {
  ConversationShareArtifactObjectUrlScope,
  readConversationShareArtifactBytes,
  sanitizeConversationShareArtifactUrls,
} from "@/v4/conversationShareArtifactReader.js";

describe("conversation share artifact reader", () => {
  it("decodes data URLs from existing bytes without touching the injected network reader", async () => {
    const read = vi.fn();
    const result = await readConversationShareArtifactBytes("data:text/plain,hello", { read });
    expect(new TextDecoder().decode(result.bytes)).toBe("hello");
    expect(result.mediaType).toBe("text/plain");
    expect(read).not.toHaveBeenCalled();
  });

  it("delegates http(s) reads to the injected anonymous reader", async () => {
    const read = vi.fn(async () => ({
      bytes: new TextEncoder().encode("remote"),
      mediaType: "text/plain",
    }));
    const result = await readConversationShareArtifactBytes("https://share.example/a.txt", {
      read,
    });
    expect(new TextDecoder().decode(result.bytes)).toBe("remote");
    expect(read).toHaveBeenCalledWith("https://share.example/a.txt", {});
  });

  it("rejects unsupported protocols without calling fetch or the reader", async () => {
    const read = vi.fn();
    for (const unsafe of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "zcode-artifact://share/a1",
      "blob:https://share.example/abc",
    ]) {
      await expect(readConversationShareArtifactBytes(unsafe, { read })).rejects.toMatchObject({
        kind: "unsupported_url",
      });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("requires an injected reader for network artifacts instead of inventing a second policy", async () => {
    await expect(
      readConversationShareArtifactBytes("https://share.example/a.txt", undefined),
    ).rejects.toBeInstanceOf(ConversationShareArtifactReadError);
  });

  it("filters injected artifact URL maps through the same protocol whitelist", () => {
    const safe = sanitizeConversationShareArtifactUrls(
      new Map([
        ["https", "https://share.example/a.png"],
        ["http", "http://127.0.0.1:1/files/a"],
        ["data", "data:text/plain,hello"],
        ["javascript", "javascript:alert(1)"],
        ["file", "file:///etc/passwd"],
        ["internal", "zcode-artifact://share/a1"],
        ["blob", "blob:https://share.example/abc"],
      ]),
    );
    expect([...safe.keys()]).toEqual(["https", "http", "data"]);
  });
});

describe("conversation share artifact object URL generations", () => {
  it("only revokes its own current generation and ignores late results from an old scope", () => {
    const revoked: string[] = [];
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });
    try {
      const scope = new ConversationShareArtifactObjectUrlScope();
      const first = scope.beginGeneration();
      const firstUrl = scope.replace(first, new Blob(["first"], { type: "text/plain" }));
      expect(firstUrl).toMatch(/^blob:/u);
      expect(scope.isCurrent(first)).toBe(true);

      const second = scope.beginGeneration();
      expect(scope.isCurrent(first)).toBe(false);
      // 旧分享范围的迟到 artifact 不能覆盖当前代次，也不该顺手撤销新代次已经建立的 URL。
      expect(scope.replace(first, new Blob(["late"], { type: "text/plain" }))).toBeNull();
      expect(revoked).toEqual([]);

      const secondUrl = scope.replace(second, new Blob(["second"], { type: "text/plain" }));
      expect(secondUrl).toMatch(/^blob:/u);
      expect(revoked).toEqual([firstUrl]);

      // 旧代次的 cleanup 晚到时不能撤销新代次的 URL。
      scope.release(first);
      expect(revoked).toEqual([firstUrl]);

      scope.dispose();
      expect(revoked).toEqual([firstUrl, secondUrl]);
    } finally {
      revoke.mockRestore();
    }
  });
});
