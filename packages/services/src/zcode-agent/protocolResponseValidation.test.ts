import { describe, expect, it } from "vitest";
import {
  ZCODE_PROTOCOL_MISMATCH_REASON_CODE,
  ZCODE_PROTOCOL_RESPONSE_INVALID_REASON_CODE,
} from "@zcode/shared";
import {
  ZCodeProtocolResponseError,
  normalizeResponseParseFailure,
} from "./protocolResponseValidation.js";

// 真实故障形态：对端返回 sessionID/messageID/id，本仓严格 schema 要 sessionId/messageId/partId。
const peerCamelCase = {
  protocol: { name: "ZCode Protocol", version: 1 },
  messages: [{ sessionID: "s1", messageID: "m1", id: "p1" }],
};

const zodLikeError = {
  issues: [
    { path: ["messages", 0, "sessionId"], message: "Required" },
    { path: ["messages", 0, "messageId"], message: "Required" },
    { path: ["messages", 0, "partId"], message: "Required" },
  ],
};

describe("normalizeResponseParseFailure", () => {
  it("reports a readable invalid-response error instead of the raw issue JSON", () => {
    const error = normalizeResponseParseFailure({
      method: "session/messages",
      result: peerCamelCase,
      error: zodLikeError,
    });
    expect(error).toBeInstanceOf(ZCodeProtocolResponseError);
    const protocolError = error as ZCodeProtocolResponseError;
    expect(protocolError.code).toBe(ZCODE_PROTOCOL_RESPONSE_INVALID_REASON_CODE);
    expect(protocolError.message).toContain("session/messages");
    expect(protocolError.message).toContain("messages.0.sessionId: Required");
    expect(protocolError.message).not.toContain("[{");
    expect(protocolError.details.issues).toHaveLength(3);
  });

  it("prefers version mismatch when the peer declares a different version", () => {
    const error = normalizeResponseParseFailure({
      method: "session/messages",
      result: { protocol: { name: "ZCode Protocol", version: 3 }, messages: [] },
      error: { issues: [{ path: ["messages", 0, "id"], message: "Unrecognized key" }] },
    }) as ZCodeProtocolResponseError;
    expect(error.code).toBe(ZCODE_PROTOCOL_MISMATCH_REASON_CODE);
    expect(error.details.actual?.version).toBe(3);
    expect(error.message).toContain("v1");
    expect(error.message).toContain("v3");
    // 版本不匹配时字段级 issues 会误导用户，不进消息正文。
    expect(error.message).not.toContain("Unrecognized key");
  });

  it("keeps the cause chain for diagnosis", () => {
    const error = normalizeResponseParseFailure({
      method: "session/list",
      result: {},
      error: zodLikeError,
    });
    expect((error as { cause?: unknown }).cause).toBe(zodLikeError);
  });

  it("stays readable when the peer declares no protocol block", () => {
    const error = normalizeResponseParseFailure({
      method: "session/create",
      result: { session: {} },
      error: zodLikeError,
    }) as ZCodeProtocolResponseError;
    expect(error.details.actual).toBeNull();
    expect(error.message).not.toContain("undefined");
    expect(error.reasonCode).toBe("agent_protocol_mismatch");
  });
});
