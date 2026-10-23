import {
  DEFERRED_TOOL_CALL_NAME,
  DeferredToolCallInputJsonSchema,
  DeferredToolCallInputSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";

const MAX_CONTROL_RESULT_BYTES = 100_000;

export const deferredToolCallEntry: ToolEntry = {
  capability: "Call a deferred tool using its loaded definition",
  metadata: {
    name: DEFERRED_TOOL_CALL_NAME,
    description:
      "Immediately call one deferred tool and return its result. Use ToolSearch to load its complete definition, then pass its exact name and input object. Only deferred tools can be called here; call resident tools directly using their normal tool calls.",
    // 调度前解包并使用目标属性，控制入口本身不声明只读或并发安全。
    readOnly: false,
    concurrentSafe: false,
    destructive: false,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
  },
  inputSchema: DeferredToolCallInputJsonSchema,
  runtimeInputSchema: DeferredToolCallInputSchema,
  outputSchema: {},
  // 目标结果由被解包的真实工具决定，控制入口本身不做输出校验。
  runtimeOutputSchema: undefined,
  permission: {
    permission: "tool.deferred_call",
    reason: "Call a deferred tool",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  timeout: { kind: "none" },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Tool call cancelled" },
  resultBudget: {
    maxInlineBytes: MAX_CONTROL_RESULT_BYTES,
    maxModelBytes: MAX_CONTROL_RESULT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_CONTROL_RESULT_BYTES, direction: "head" },
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
  handler: async () => {
    throw new Error("DeferredToolCall must be resolved before tool execution.");
  },
};
