import { describe, expect, it } from "vitest";
import {
  formatZcodeProtocolMismatchMessage,
  formatZcodeResponseInvalidMessage,
  isProtocolIdentityCompatible,
  readProtocolIdentity,
  summarizeProtocolIssues,
} from "./handshake.js";

const expected = { name: "ZCode Protocol", version: 1 };

describe("readProtocolIdentity", () => {
  it("reads a well-formed protocol block", () => {
    expect(readProtocolIdentity({ protocol: { name: "ZCode Protocol", version: 3 } })).toEqual({
      name: "ZCode Protocol",
      version: 3,
    });
  });

  it("returns null instead of guessing when the block is missing or malformed", () => {
    expect(readProtocolIdentity(null)).toBeNull();
    expect(readProtocolIdentity({})).toBeNull();
    expect(readProtocolIdentity({ protocol: { name: "", version: 1 } })).toBeNull();
    expect(readProtocolIdentity({ protocol: { name: "ZCode Protocol", version: "3" } })).toBeNull();
    expect(readProtocolIdentity({ protocol: { name: "ZCode Protocol", version: 1.5 } })).toBeNull();
  });
});

describe("isProtocolIdentityCompatible", () => {
  it("requires both name and version to match", () => {
    expect(isProtocolIdentityCompatible(expected, { name: "ZCode Protocol", version: 1 })).toBe(
      true,
    );
    expect(isProtocolIdentityCompatible(expected, { name: "ZCode Protocol", version: 3 })).toBe(
      false,
    );
    expect(isProtocolIdentityCompatible(expected, { name: "Other", version: 1 })).toBe(false);
    expect(isProtocolIdentityCompatible(expected, null)).toBe(false);
  });
});

describe("summarizeProtocolIssues", () => {
  it("keeps at most the requested number of path:message pairs", () => {
    const error = {
      issues: [
        { path: ["messages", 0, "sessionId"], message: "Required" },
        { path: ["messages", 0, "messageId"], message: "Required" },
        { path: ["messages", 0, "partId"], message: "Required" },
        { path: ["messages", 1, "id"], message: "Unrecognized key" },
      ],
    };
    expect(summarizeProtocolIssues(error)).toEqual([
      "messages.0.sessionId: Required",
      "messages.0.messageId: Required",
      "messages.0.partId: Required",
    ]);
  });

  it("skips non-object issues and tolerates missing issues", () => {
    expect(summarizeProtocolIssues({ issues: ["nope", { path: [], message: "bad" }] })).toEqual([
      "(root): bad",
    ]);
    expect(summarizeProtocolIssues(new Error("plain"))).toEqual([]);
    expect(summarizeProtocolIssues(null)).toEqual([]);
  });
});

describe("protocol failure messages", () => {
  it("names the method and both protocol identities on mismatch", () => {
    const message = formatZcodeProtocolMismatchMessage({
      method: "session/messages",
      expected,
      actual: { name: "ZCode Protocol", version: 3 },
    });
    expect(message).toContain("session/messages");
    expect(message).toContain("v1");
    expect(message).toContain("v3");
  });

  it("says the peer did not declare a version instead of inventing one", () => {
    const message = formatZcodeProtocolMismatchMessage({
      method: "session/messages",
      expected,
      actual: null,
    });
    expect(message).toContain("未声明协议版本");
    expect(message).not.toContain("undefined");
    expect(message).not.toContain("NaN");
  });

  it("keeps invalid-response text bounded and free of raw issue JSON", () => {
    const message = formatZcodeResponseInvalidMessage({
      method: "session/messages",
      expected,
      issues: summarizeProtocolIssues({
        issues: [{ path: ["messages", 0, "sessionId"], message: "Required" }],
      }),
    });
    expect(message).toContain("messages.0.sessionId: Required");
    expect(message).not.toContain("[{");
    expect(message.length).toBeLessThanOrEqual(301);
  });

  it("never produces an unbounded message", () => {
    const message = formatZcodeResponseInvalidMessage({
      method: "session/messages",
      expected,
      issues: Array.from({ length: 3 }, (_, index) => `field${index}: ${"x".repeat(400)}`),
    });
    expect(message.length).toBeLessThanOrEqual(301);
    expect(message.endsWith("…")).toBe(true);
  });
});
