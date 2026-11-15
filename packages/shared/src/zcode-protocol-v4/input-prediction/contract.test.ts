import { describe, expect, it } from "vitest";

import { exampleRemoteInputPrediction } from "./contract.example.js";
import {
  INPUT_PREDICTION_DECISIONS,
  emptyInputPredictionResult,
  v4ConversationInputPredictionParamsSchema,
  v4ConversationInputPredictionResultSchema,
} from "./contract.js";
import { remoteInputPredictionModule } from "./module.js";
import { hostCapabilitiesSchema } from "../transport.js";

describe("remote-input-prediction contract", () => {
  it("declares its module manifest", () => {
    expect(remoteInputPredictionModule.id).toBe("remote-input-prediction");
  });

  it("builds empty results for every non-show decision and echoes requestId", () => {
    for (const decision of INPUT_PREDICTION_DECISIONS) {
      if (decision === "show") continue;
      expect(emptyInputPredictionResult(decision, "r1")).toEqual({
        decision,
        candidates: [],
        topConfidence: 0,
        requestId: "r1",
      });
    }
  });

  it("rejects invalid params without echoing anything", () => {
    expect(exampleRemoteInputPrediction({ sessionId: "", revision: -1 })).toEqual(
      emptyInputPredictionResult("unavailable"),
    );
    expect(exampleRemoteInputPrediction({ sessionId: "s", revision: 0, requestId: "r" })).toEqual(
      emptyInputPredictionResult("suppress_no_context", "r"),
    );
  });

  it("rejects non-strict params, blank candidates and over-limit payloads", () => {
    expect(
      v4ConversationInputPredictionParamsSchema.safeParse({
        sessionId: "s",
        revision: 0,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      v4ConversationInputPredictionResultSchema.safeParse({
        decision: "show",
        candidates: [{ text: "   ", confidence: 0.9 }],
        topConfidence: 0.9,
      }).success,
    ).toBe(false);
    expect(
      v4ConversationInputPredictionResultSchema.safeParse({
        decision: "show",
        candidates: [{ text: "a\nb", confidence: 0.9 }],
        topConfidence: 0.9,
      }).success,
    ).toBe(false);
    expect(
      v4ConversationInputPredictionParamsSchema.safeParse({
        sessionId: "s",
        revision: 0,
        draft: "x".repeat(4_001),
      }).success,
    ).toBe(false);
  });

  it("hello cap 是可选布尔：旧 Host 缺席不等于 true，字段读写兼容", () => {
    const base = {
      nativeDialogs: false,
      localTerminal: false,
      binaryFrames: false,
      compression: "none" as const,
    };
    assertCapability(base, undefined);
    assertCapability({ ...base, inputPrediction: false }, false);
    assertCapability({ ...base, inputPrediction: true }, true);
    expect(hostCapabilitiesSchema.safeParse({ ...base, inputPrediction: "yes" }).success).toBe(
      false,
    );
  });
});

function assertCapability(base: Record<string, unknown>, expected: boolean | undefined): void {
  const parsed = hostCapabilitiesSchema.parse(
    expected === undefined ? base : { ...base, inputPrediction: expected },
  );
  expect(parsed.inputPrediction).toBe(expected);
}
